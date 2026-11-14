import type { LiteTokenUsage } from "../contracts/events.js";
import type { LiteToolDefinition } from "../context/context-assembler.js";
import type {
  LiteProvider,
  LiteProviderMessage,
  LiteProviderRequest,
  LiteProviderResponse,
  LiteToolCall,
} from "./provider.js";

export interface LiteToolCallResult {
  readonly callId: string;
  readonly toolName: string;
  readonly outputText: string;
  readonly isError: boolean;
}

export type LiteToolExecutor = (
  call: LiteToolCall,
  signal?: AbortSignal,
) => Promise<LiteToolCallResult>;

export interface ProviderTurnInput {
  readonly provider: LiteProvider;
  readonly messages: readonly LiteProviderMessage[];
  readonly tools: readonly LiteToolDefinition[];
  readonly maxOutputTokens: number;
  readonly executeTool: LiteToolExecutor;
  readonly signal?: AbortSignal;
}

export interface LiteToolCallRecord {
  readonly call: LiteToolCall;
  readonly result: LiteToolCallResult;
}

export type ProviderTurnOutcome =
  | "completed"
  | "error"
  | "max-iterations"
  | "aborted";

export interface ProviderTurnResult {
  readonly outcome: ProviderTurnOutcome;
  readonly text: string;
  readonly usage: LiteTokenUsage;
  readonly toolCalls: readonly LiteToolCallRecord[];
  readonly iterations: number;
  readonly reasoning?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

const ZERO_USAGE: LiteTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function addUsage(total: LiteTokenUsage, usage: LiteTokenUsage | undefined): LiteTokenUsage {
  if (usage === undefined) return total;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
  };
}

function result(
  outcome: ProviderTurnOutcome,
  text: string,
  usage: LiteTokenUsage,
  toolCalls: readonly LiteToolCallRecord[],
  iterations: number,
  errorCode?: string,
  errorMessage?: string,
  reasoning?: string,
): ProviderTurnResult {
  return {
    outcome,
    text,
    usage,
    toolCalls,
    iterations,
    ...(reasoning === undefined || reasoning === "" ? {} : { reasoning }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

/**
 * Runs a provider turn to completion: request -> optional tool batch -> repeat.
 *
 * The runner owns the loop and budget; it does not know how tools are executed
 * or how provider-specific messages are serialized.
 */
export class ProviderTurnRunner {
  private readonly maxIterations: number;
  private readonly maxToolCalls: number;

  constructor(options: { readonly maxIterations?: number; readonly maxToolCalls?: number } = {}) {
    this.maxIterations = options.maxIterations ?? 12;
    this.maxToolCalls = options.maxToolCalls ?? 40;
    if (!Number.isInteger(this.maxIterations) || this.maxIterations < 1) {
      throw new Error("maxIterations must be a positive integer");
    }
    if (!Number.isInteger(this.maxToolCalls) || this.maxToolCalls < 1) {
      throw new Error("maxToolCalls must be a positive integer");
    }
  }

  async run(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    const messages: LiteProviderMessage[] = [...input.messages];
    const toolCalls: LiteToolCallRecord[] = [];
    let usage = ZERO_USAGE;
    let iterations = 0;
    let reasoning = "";

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      if (isAborted(input.signal)) {
        return result("aborted", "", usage, toolCalls, iterations, "LITE_TURN_CANCELLED", "turn aborted");
      }
      iterations += 1;

      const request: LiteProviderRequest = {
        providerId: input.provider.providerId,
        modelIdentifier: input.provider.modelIdentifier,
        messages,
        tools: input.tools,
        maxOutputTokens: input.maxOutputTokens,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      };

      let response: LiteProviderResponse;
      try {
        response = await input.provider.complete(request);
      } catch (error) {
        return result(
          "error",
          "",
          usage,
          toolCalls,
          iterations,
          "LITE_PROVIDER_REQUEST_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }

      usage = addUsage(usage, response.kind === "error" ? undefined : response.usage);
      if (response.kind !== "error" && response.reasoning !== undefined) {
        reasoning += response.reasoning;
      }

      if (response.kind === "error") {
        return result(
          "error",
          "",
          usage,
          toolCalls,
          iterations,
          response.code,
          response.message,
        );
      }
      if (response.kind === "text") {
        return result("completed", response.text, usage, toolCalls, iterations, undefined, undefined, reasoning);
      }
      if (response.calls.length === 0) {
        return result("completed", response.text ?? "", usage, toolCalls, iterations, undefined, undefined, reasoning);
      }

      messages.push({
        role: "assistant",
        content: response.text ?? "",
        toolCalls: response.calls,
      });

      for (const call of response.calls) {
        if (toolCalls.length >= this.maxToolCalls) {
          return result(
            "max-iterations",
            response.text ?? "",
            usage,
            toolCalls,
            iterations,
            "LITE_TURN_BUDGET_EXHAUSTED",
            "maximum tool calls reached",
          );
        }
        if (isAborted(input.signal)) {
          return result("aborted", "", usage, toolCalls, iterations, "LITE_TURN_CANCELLED", "turn aborted");
        }

        let execution: LiteToolCallResult;
        try {
          execution = await input.executeTool(call, input.signal);
        } catch (error) {
          execution = {
            callId: call.callId,
            toolName: call.toolName,
            outputText: `LITE_TOOL_EXECUTION_FAILED: ${
              error instanceof Error ? error.message : String(error)
            }`,
            isError: true,
          };
        }
        toolCalls.push({ call, result: execution });
        messages.push({
          role: "tool",
          content: execution.outputText,
          toolCallId: call.callId,
          toolName: call.toolName,
        });
      }
    }

    return result(
      "max-iterations",
      "",
      usage,
      toolCalls,
      iterations,
      "LITE_TURN_BUDGET_EXHAUSTED",
      "maximum provider iterations reached",
    );
  }
}

