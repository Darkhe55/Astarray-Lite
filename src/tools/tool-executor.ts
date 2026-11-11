import { LiteError } from "../contracts/errors.js";
import { scanToolArguments, sanitizeToolOutput, validateToolArguments } from "./tool-schema.js";
import type { ToolRegistry } from "./tool-registry.js";
import type {
  LiteToolAuditRecord,
  LiteToolExecutionResult,
  LiteToolSpec,
} from "./tool-types.js";

export type ToolAuthorizationDecision = "allow" | "ask" | "deny";

export interface ToolExecutionRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly signal?: AbortSignal;
}

export interface ToolExecutionHooks {
  readonly authorize?: (
    spec: LiteToolSpec,
    argumentsValue: unknown,
    request: ToolExecutionRequest,
  ) => Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;
  readonly requestApproval?: (
    spec: LiteToolSpec,
    argumentsValue: unknown,
  ) => Promise<boolean>;
  readonly createBackup?: (spec: LiteToolSpec, argumentsValue: unknown) => Promise<void>;
  readonly onAudit?: (record: LiteToolAuditRecord) => void | Promise<void>;
}

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly hooks?: ToolExecutionHooks;
  readonly timeoutMilliseconds?: number;
  readonly maxOutputCharacters?: number;
}

interface ExecutionOutcome {
  readonly kind: "result" | "thrown" | "timeout";
  readonly outputText?: string;
  readonly isError?: boolean;
  readonly error?: unknown;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof LiteError) return error.message;
  return "tool execution failed";
}

/**
 * Runs the tool pipeline: parse -> existence -> schema -> argument scan ->
 * authorization -> backup -> execute with timeout -> sanitize -> audit.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly hooks: ToolExecutionHooks;
  private readonly timeoutMilliseconds: number;
  private readonly maxOutputCharacters: number;

  constructor(options: ToolExecutorOptions) {
    this.registry = options.registry;
    this.hooks = options.hooks ?? {};
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.maxOutputCharacters = options.maxOutputCharacters ?? 100_000;
    if (!Number.isInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds < 1) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "timeoutMilliseconds must be positive");
    }
    if (!Number.isInteger(this.maxOutputCharacters) || this.maxOutputCharacters < 1) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "maxOutputCharacters must be positive");
    }
  }

  async execute(request: ToolExecutionRequest): Promise<LiteToolExecutionResult> {
    const startedAt = Date.now();
    const finish = async (
      partial: {
        readonly ok: boolean;
        readonly outputText: string;
        readonly errorCode?: string;
        readonly errorMessage?: string;
        readonly truncated?: boolean;
      },
    ): Promise<LiteToolExecutionResult> => {
      const durationMilliseconds = Date.now() - startedAt;
      const result: LiteToolExecutionResult = {
        ok: partial.ok,
        callId: request.callId,
        toolName: request.toolName,
        outputText: partial.outputText,
        ...(partial.errorCode === undefined ? {} : { errorCode: partial.errorCode }),
        ...(partial.errorMessage === undefined ? {} : { errorMessage: partial.errorMessage }),
        truncated: partial.truncated ?? false,
        durationMilliseconds,
      };
      const audit: LiteToolAuditRecord = {
        callId: request.callId,
        toolName: request.toolName,
        ok: result.ok,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        durationMilliseconds,
        outputCharacters: result.outputText.length,
        truncated: result.truncated,
        executedAtIso: new Date().toISOString(),
      };
      if (this.hooks.onAudit !== undefined) {
        try {
          await this.hooks.onAudit(audit);
        } catch {
          // Audit failures must not change the tool result.
        }
      }
      return result;
    };

    let spec: LiteToolSpec;
    try {
      spec = this.registry.require(request.toolName);
    } catch (error) {
      if (error instanceof LiteError) {
        return finish({ ok: false, outputText: "", errorCode: error.code, errorMessage: error.message });
      }
      return finish({
        ok: false,
        outputText: "",
        errorCode: "LITE_TOOL_NOT_FOUND",
        errorMessage: "tool not found",
      });
    }

    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(request.argumentsJson) as unknown;
    } catch {
      return finish({
        ok: false,
        outputText: "",
        errorCode: "LITE_INVALID_ARGUMENT",
        errorMessage: "tool arguments are not valid JSON",
      });
    }

    const validation = validateToolArguments(spec.inputSchema, argumentsValue);
    if (!validation.valid) {
      const first = validation.issues[0];
      return finish({
        ok: false,
        outputText: "",
        errorCode: "LITE_TOOL_SCHEMA_INVALID",
        errorMessage: first === undefined ? "tool arguments do not match the schema" : `${first.path}: ${first.message}`,
      });
    }

    try {
      scanToolArguments(argumentsValue);
    } catch (error) {
      if (error instanceof LiteError) {
        return finish({ ok: false, outputText: "", errorCode: error.code, errorMessage: error.message });
      }
      return finish({
        ok: false,
        outputText: "",
        errorCode: "LITE_SENSITIVE_CONTENT_BLOCKED",
        errorMessage: "tool arguments were rejected",
      });
    }

    if (this.hooks.authorize !== undefined) {
      let decision: ToolAuthorizationDecision;
      try {
        decision = await this.hooks.authorize(spec, argumentsValue, request);
      } catch {
        return finish({
          ok: false,
          outputText: "",
          errorCode: "LITE_PERMISSION_DENIED",
          errorMessage: "permission check failed",
        });
      }
      if (decision === "deny") {
        return finish({
          ok: false,
          outputText: "",
          errorCode: "LITE_PERMISSION_DENIED",
          errorMessage: "permission denied",
        });
      }
      if (decision === "ask") {
        if (this.hooks.requestApproval === undefined) {
          return finish({
            ok: false,
            outputText: "",
            errorCode: "LITE_PERMISSION_DENIED",
            errorMessage: "approval is required but unavailable",
          });
        }
        try {
          const approved = await this.hooks.requestApproval(spec, argumentsValue);
          if (!approved) {
            return finish({
              ok: false,
              outputText: "",
              errorCode: "LITE_PERMISSION_DENIED",
              errorMessage: "permission denied by user",
            });
          }
        } catch {
          return finish({
            ok: false,
            outputText: "",
            errorCode: "LITE_PERMISSION_TIMEOUT",
            errorMessage: "approval request failed or timed out",
          });
        }
      }
    }

    if (spec.requiresBackup && this.hooks.createBackup !== undefined) {
      try {
        await this.hooks.createBackup(spec, argumentsValue);
      } catch {
        return finish({
          ok: false,
          outputText: "",
          errorCode: "LITE_BACKUP_FAILED",
          errorMessage: "pre-image backup failed",
        });
      }
    }

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    if (request.signal !== undefined) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeoutMilliseconds = spec.timeoutMilliseconds ?? this.timeoutMilliseconds;
    const execution: Promise<ExecutionOutcome> = spec
      .handler(argumentsValue, {
        callId: request.callId,
        toolName: spec.name,
        signal: controller.signal,
      })
      .then(
        (value): ExecutionOutcome => ({
          kind: "result",
          outputText: value.outputText,
          isError: value.isError === true,
        }),
        (error: unknown): ExecutionOutcome => ({ kind: "thrown", error }),
      );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutOutcome = new Promise<ExecutionOutcome>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, timeoutMilliseconds);
    });

    let outcome: ExecutionOutcome;
    try {
      outcome = await Promise.race([execution, timeoutOutcome]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (request.signal !== undefined) request.signal.removeEventListener("abort", onAbort);
    }

    if (outcome.kind === "timeout") {
      return finish({
        ok: false,
        outputText: "",
        errorCode: "LITE_TOOL_EXECUTION_FAILED",
        errorMessage: "tool timed out",
      });
    }
    if (outcome.kind === "thrown") {
      const error = outcome.error;
      return finish({
        ok: false,
        outputText: "",
        errorCode: error instanceof LiteError ? error.code : "LITE_TOOL_EXECUTION_FAILED",
        errorMessage: safeErrorMessage(error),
      });
    }
    if (outcome.kind !== "result") {
      return finish({
        ok: false,
        outputText: "",
        errorCode: "LITE_TOOL_EXECUTION_FAILED",
        errorMessage: "tool produced an unknown outcome",
      });
    }

    const sanitized = sanitizeToolOutput(outcome.outputText ?? "", this.maxOutputCharacters);
    return finish({
      ok: outcome.isError !== true,
      outputText: sanitized.text,
      truncated: sanitized.truncated,
      ...(outcome.isError === true
        ? { errorCode: "LITE_TOOL_EXECUTION_FAILED", errorMessage: "tool reported an error" }
        : {}),
    });
  }
}
