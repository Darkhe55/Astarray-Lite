import { describe, expect, it, vi } from "vitest";

import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { LiteToolAuditRecord, LiteToolSpec } from "../../src/tools/tool-types.js";

const githubTokenPrefix = ["gh", "p_"].join("");

function spec(overrides: Partial<LiteToolSpec> = {}): LiteToolSpec {  return {
    name: "echo",
    summary: "echo text",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: true,
    requiresBackup: false,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, path: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (argumentsValue) => ({
      outputText: String((argumentsValue as { text: string }).text),
    }),
    ...overrides,
  };
}

function setup(
  overrides: Partial<LiteToolSpec> = {},
  options: {
    hooks?: ConstructorParameters<typeof ToolExecutor>[0]["hooks"];
    timeoutMilliseconds?: number;
    maxOutputCharacters?: number;
  } = {},
): { executor: ToolExecutor; registry: ToolRegistry; audits: LiteToolAuditRecord[] } {
  const registry = new ToolRegistry();
  registry.register(spec(overrides));
  const audits: LiteToolAuditRecord[] = [];
  const executor = new ToolExecutor({
    registry,
    hooks: {
      ...(options.hooks ?? {}),
      onAudit: (record) => {
        audits.push(record);
      },
    },
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
    ...(options.maxOutputCharacters === undefined
      ? {}
      : { maxOutputCharacters: options.maxOutputCharacters }),
  });
  return { executor, registry, audits };
}

describe("ToolExecutor", () => {
  it("executes a valid tool and writes an audit record", async () => {
    const { executor, audits } = setup();
    const result = await executor.execute({
      callId: "call-1",
      toolName: "echo",
      argumentsJson: '{"text":"hello"}',
    });

    expect(result).toMatchObject({ ok: true, outputText: "hello", truncated: false });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ callId: "call-1", toolName: "echo", ok: true });
  });

  it("rejects unknown, disabled and malformed tools", async () => {
    const { executor, registry } = setup();
    const unknown = await executor.execute({
      callId: "call-1",
      toolName: "missing",
      argumentsJson: "{}",
    });
    expect(unknown.errorCode).toBe("LITE_TOOL_NOT_FOUND");

    registry.disable("echo");
    const disabled = await executor.execute({
      callId: "call-2",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(disabled.errorCode).toBe("LITE_TOOL_DISABLED");

    registry.enable("echo");
    const malformed = await executor.execute({
      callId: "call-3",
      toolName: "echo",
      argumentsJson: "{broken",
    });
    expect(malformed.errorCode).toBe("LITE_INVALID_ARGUMENT");
  });

  it("rejects schema mismatches and secret arguments", async () => {
    const { executor } = setup();
    const schemaError = await executor.execute({
      callId: "call-1",
      toolName: "echo",
      argumentsJson: "{}",
    });
    expect(schemaError.errorCode).toBe("LITE_TOOL_SCHEMA_INVALID");

    const secret = await executor.execute({
      callId: "call-2",
      toolName: "echo",
      argumentsJson: JSON.stringify({ text: `${githubTokenPrefix}${"a".repeat(30)}` }),
    });
    expect(secret.errorCode).toBe("LITE_SENSITIVE_CONTENT_BLOCKED");
  });

  it("enforces allow, deny and ask authorization", async () => {
    const tool = vi.fn(async () => ({ outputText: "allowed" }));
    const deny = vi.fn(async (): Promise<"deny"> => "deny");
    const denied = setup({ handler: tool }, { hooks: { authorize: deny } });
    const deniedResult = await denied.executor.execute({
      callId: "call-1",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(deniedResult.errorCode).toBe("LITE_PERMISSION_DENIED");
    expect(tool).not.toHaveBeenCalled();

    const ask = setup(
      { handler: tool },
      {
        hooks: {
          authorize: async (): Promise<"ask"> => "ask",
          requestApproval: async () => true,
        },
      },
    );
    const approved = await ask.executor.execute({
      callId: "call-2",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(approved.ok).toBe(true);
    expect(tool).toHaveBeenCalledTimes(1);

    const rejected = setup(
      { handler: tool },
      {
        hooks: {
          authorize: async (): Promise<"ask"> => "ask",
          requestApproval: async () => false,
        },
      },
    );
    const rejectedResult = await rejected.executor.execute({
      callId: "call-3",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(rejectedResult.errorCode).toBe("LITE_PERMISSION_DENIED");
  });

  it("runs the pre-image backup hook for mutating tools", async () => {
    const backup = vi.fn(async () => undefined);
    const { executor } = setup(
      { requiresBackup: true },
      { hooks: { createBackup: backup } },
    );
    await executor.execute({
      callId: "call-1",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it("sanitizes, truncates and times out output", async () => {
    const sanitized = setup({
      handler: async () => ({ outputText: "\u001b[31mred\u001b[0m" }),
    });
    const sanitizedResult = await sanitized.executor.execute({
      callId: "call-1",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(sanitizedResult.outputText).toBe("red");

    const truncated = setup(
      { handler: async () => ({ outputText: "x".repeat(100) }) },
      { maxOutputCharacters: 20 },
    );
    const truncatedResult = await truncated.executor.execute({
      callId: "call-2",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(truncatedResult.truncated).toBe(true);
    expect(truncatedResult.outputText.endsWith("[truncated]")).toBe(true);

    const slow = setup(
      { handler: async () => new Promise<never>(() => undefined) },
      { timeoutMilliseconds: 10 },
    );
    const slowResult = await slow.executor.execute({
      callId: "call-3",
      toolName: "echo",
      argumentsJson: '{"text":"x"}',
    });
    expect(slowResult.errorCode).toBe("LITE_TOOL_EXECUTION_FAILED");
    expect(slowResult.errorMessage ?? "").toContain("timed out");
  });
});
