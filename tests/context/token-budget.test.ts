import { describe, expect, it } from "vitest";

import { buildContextManifest } from "../../src/context/context-manifest.js";
import {
  DEFAULT_CONTEXT_BLOCK_BUDGETS,
  estimateTokens,
  trimContext,
} from "../../src/context/token-budget.js";
import type { LiteContextAssemblyInput } from "../../src/context/context-assembler.js";

function input(overrides: Partial<LiteContextAssemblyInput> = {}): LiteContextAssemblyInput {
  return {
    promptVersion: "lite-1.0",
    promptText: "system prompt",
    toolsetRevision: 1,
    tools: [{ name: "read_file", summary: "read", inputSchema: {} }],
    user: { messageId: "msg_01JABCDEFG", text: "hello", attachments: [] },
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates four code points per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("你好世界")).toBe(1);
  });
});

describe("trimContext", () => {
  it("does not trim a context under budget", () => {
    const result = trimContext(input(), { countTokens: (text) => text.length });
    expect(result.wasTrimmed).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.trimmedBlockIds).toEqual([]);
  });

  it("truncates an oversized user message", () => {
    const result = trimContext(
      input({
        user: { messageId: "msg_01JABCDEFG", text: "x".repeat(10_000), attachments: [] },
      }),
      {
        countTokens: (text) => text.length,
        blockBudgets: { ...DEFAULT_CONTEXT_BLOCK_BUDGETS, user: 2_000 },
      },
    );
    const userBlock = result.assembled.blocks.find((block) => block.blockId === "user");
    expect(result.wasTrimmed).toBe(true);
    expect(result.steps).toContainEqual(expect.objectContaining({ blockId: "user" }));
    expect((userBlock?.content as { text: string }).text.endsWith("[truncated]")).toBe(true);
    expect((userBlock?.content as { text: string }).text.length).toBeLessThanOrEqual(2_000);
  });

  it("drops the memory note index before the profile", () => {
    const notes = Array.from({ length: 50 }, (_, index) => ({
      path: `notes/${index}.md`,
      summary: "s".repeat(100),
    }));
    const result = trimContext(
      input({
        memory: { profileText: "profile", noteIndex: notes, revision: 1 },
      }),
      {
        countTokens: (text) => text.length,
        blockBudgets: { ...DEFAULT_CONTEXT_BLOCK_BUDGETS, memory: 500 },
      },
    );
    const memoryBlock = result.assembled.blocks.find((block) => block.blockId === "memory");
    expect(result.steps).toContainEqual(expect.objectContaining({ blockId: "memory" }));
    expect((memoryBlock?.content as { noteIndex: unknown[] }).noteIndex).toEqual([]);
  });

  it("drops installed tools but keeps basic tools", () => {
    const result = trimContext(
      input({
        tools: [
          { name: "read_file", summary: "read", inputSchema: {}, category: "basic" },
          { name: "mcp__search", summary: "search", inputSchema: {}, category: "installed" },
        ],
      }),
      {
        countTokens: (text) => text.length,
        blockBudgets: { ...DEFAULT_CONTEXT_BLOCK_BUDGETS, tools: 50 },
      },
    );
    const toolsBlock = result.assembled.blocks.find((block) => block.blockId === "tools");
    const tools = (toolsBlock?.content as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(result.steps).toContainEqual(expect.objectContaining({ blockId: "tools" }));
  });

  it("never trims the system block", () => {
    expect(() =>
      trimContext(input({ promptText: "x".repeat(8_000) }), {
        countTokens: (text) => text.length,
        blockBudgets: { ...DEFAULT_CONTEXT_BLOCK_BUDGETS, system: 100 },
      }),
    ).toThrow(/system block/u);
  });

  it("fails when no further trimming can meet the total budget", () => {
    expect(() =>
      trimContext(input({ promptText: "x".repeat(500) }), {
        totalTokenBudget: 10,
        countTokens: (text) => text.length,
      }),
    ).toThrow(/context exceeds/u);
  });

  it("marks trimmed blocks in the manifest", () => {
    const trimmed = trimContext(
      input({
        user: { messageId: "msg_01JABCDEFG", text: "x".repeat(10_000), attachments: [] },
      }),
      {
        countTokens: (text) => text.length,
        blockBudgets: { ...DEFAULT_CONTEXT_BLOCK_BUDGETS, user: 2_000 },
      },
    );
    const manifest = buildContextManifest({
      assembled: trimmed.assembled,
      turnId: "trn_01JABCDEFG",
      createdAtIso: "2026-01-01T00:00:00.000Z",
      providerId: "openai",
      modelIdentifier: "gpt-4.1",
      tokenBudget: 64_000,
      countTokens: (text) => text.length,
      trimmedBlockIds: trimmed.trimmedBlockIds,
      originalTokenCounts: { user: 10_000 },
    });
    const userBlock = manifest.blocks.find((block) => block.blockId === "user");
    expect(userBlock?.truncated).toBe(true);
    expect(userBlock?.originalTokenCount).toBe(10_000);
  });
});
