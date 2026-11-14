import { describe, expect, it } from "vitest";

import { FakeProvider } from "../../src/runtime/fake-provider.js";
import { ProviderTurnRunner } from "../../src/runtime/provider-turn-runner.js";
import type { LiteToolCallResult } from "../../src/runtime/provider-turn-runner.js";
import type { LiteToolCall } from "../../src/runtime/provider.js";

const messages = [{ role: "user" as const, content: "hello" }];

function execute(call: LiteToolCall): Promise<LiteToolCallResult> {
  return Promise.resolve({
    callId: call.callId,
    toolName: call.toolName,
    outputText: `executed ${call.toolName}`,
    isError: false,
  });
}

describe("ProviderTurnRunner", () => {
  it("returns a text response and records usage", async () => {
    const provider = new FakeProvider([
      {
        kind: "text",
        text: "done",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
      },
    ]);
    const runner = new ProviderTurnRunner();
    const result = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: execute,
    });

    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
    expect(result.iterations).toBe(1);
    expect(provider.requests).toHaveLength(1);
  });

  it("executes a tool batch and continues the conversation", async () => {
    const provider = new FakeProvider([
      {
        kind: "tool-calls",
        text: "calling",
        calls: [{ callId: "call-1", toolName: "read_file", argumentsJson: "{}" }],
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      },
      { kind: "text", text: "finished" },
    ]);
    const runner = new ProviderTurnRunner();
    const result = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: execute,
    });

    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("finished");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.result.outputText).toBe("executed read_file");
    expect(result.usage.inputTokens).toBe(1);
    const secondRequest = provider.requests[1];
    expect(secondRequest?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(secondRequest?.messages[2]?.toolCallId).toBe("call-1");
  });

  it("stops at the provider iteration limit", async () => {
    const toolCall = { callId: "call-1", toolName: "read_file", argumentsJson: "{}" };
    const provider = new FakeProvider([
      { kind: "tool-calls", calls: [toolCall] },
      { kind: "tool-calls", calls: [toolCall] },
      { kind: "tool-calls", calls: [toolCall] },
    ]);
    const runner = new ProviderTurnRunner({ maxIterations: 2 });
    const result = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: execute,
    });

    expect(result.outcome).toBe("max-iterations");
    expect(result.errorCode).toBe("LITE_TURN_BUDGET_EXHAUSTED");
    expect(provider.requests).toHaveLength(2);
  });

  it("stops at the tool call limit", async () => {
    const provider = new FakeProvider([
      {
        kind: "tool-calls",
        calls: [
          { callId: "call-1", toolName: "read_file", argumentsJson: "{}" },
          { callId: "call-2", toolName: "write_file", argumentsJson: "{}" },
        ],
      },
    ]);
    const runner = new ProviderTurnRunner({ maxToolCalls: 1 });
    const result = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: execute,
    });

    expect(result.outcome).toBe("max-iterations");
    expect(result.errorCode).toBe("LITE_TURN_BUDGET_EXHAUSTED");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("turns a thrown tool error into an error result and continues", async () => {
    const provider = new FakeProvider([
      {
        kind: "tool-calls",
        calls: [{ callId: "call-1", toolName: "read_file", argumentsJson: "{}" }],
      },
      { kind: "text", text: "recovered" },
    ]);
    const runner = new ProviderTurnRunner();
    const result = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: async () => {
        throw new Error("boom");
      },
    });

    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("recovered");
    expect(result.toolCalls[0]?.result.isError).toBe(true);
    expect(result.toolCalls[0]?.result.outputText).toContain("LITE_TOOL_EXECUTION_FAILED");
  });

  it("returns provider errors and aborts before the first request", async () => {
    const provider = new FakeProvider([
      {
        kind: "error",
        code: "LITE_PROVIDER_RATE_LIMITED",
        message: "slow down",
        isRetryable: true,
      },
    ]);
    const runner = new ProviderTurnRunner();
    const errorResult = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: execute,
    });
    expect(errorResult.outcome).toBe("error");
    expect(errorResult.errorCode).toBe("LITE_PROVIDER_RATE_LIMITED");

    const controller = new AbortController();
    controller.abort();
    const aborted = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: execute,
      signal: controller.signal,
    });
    expect(aborted.outcome).toBe("aborted");
    expect(aborted.errorCode).toBe("LITE_TURN_CANCELLED");
  });

  it("preempts before the next provider call when a user message is waiting", async () => {
    const provider = new FakeProvider([{ kind: "text", text: "should not run" }]);
    const runner = new ProviderTurnRunner();
    const result = await runner.run({
      provider,
      messages,
      tools: [],
      maxOutputTokens: 100,
      executeTool: execute,
      shouldPreempt: () => true,
    });
    expect(result.outcome).toBe("preempted");
    expect(result.errorCode).toBe("LITE_TURN_PREEMPTED");
    expect(provider.requests).toHaveLength(0);
  });
});

