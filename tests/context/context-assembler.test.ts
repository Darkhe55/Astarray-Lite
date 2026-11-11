import { describe, expect, it } from "vitest";

import { assembleContext, type LiteContextAssemblyInput } from "../../src/context/context-assembler.js";
import { sha256Digest } from "../../src/context/hash.js";

function input(overrides: Partial<LiteContextAssemblyInput> = {}): LiteContextAssemblyInput {
  return {
    promptVersion: "lite-1.0",
    promptText: "system prompt",
    toolsetRevision: 3,
    tools: [
      { name: "write_file", summary: "write", inputSchema: { type: "object" } },
      { name: "read_file", summary: "read", inputSchema: { type: "object" } },
    ],
    memory: {
      profileText: "prefers concise answers",
      noteIndex: [{ path: "notes/a.md", summary: "architecture" }],
      revision: 2,
    },
    task: {
      taskId: "tsk_01JABCDEFG",
      revision: 7,
      taskKind: "normal",
      documentText: "# Task\nDo the thing.",
    },
    transcript: [{ turnId: "trn_01JABCDEFG", role: "assistant", summary: "started" }],
    monitor: { lines: ["build: ok"] },
    user: { messageId: "msg_01JABCDEFG", text: "please continue", attachments: [] },
    ...overrides,
  };
}

describe("assembleContext", () => {
  it("assembles the seven blocks in fixed order", () => {
    const assembled = assembleContext(input());
    expect(assembled.blocks.map((block) => block.blockId)).toEqual([
      "system",
      "tools",
      "memory",
      "task",
      "transcript",
      "monitor",
      "user",
    ]);
    expect(assembled.blocks.map((block) => block.cacheClass)).toEqual([
      "stable",
      "stable",
      "stable",
      "task",
      "task",
      "volatile",
      "volatile",
    ]);
  });

  it("sorts tools by name and hashes every block", () => {
    const assembled = assembleContext(input());
    const tools = assembled.blocks[1];
    expect(tools?.content).toMatchObject({
      tools: [{ name: "read_file" }, { name: "write_file" }],
    });
    for (const block of assembled.blocks) {
      expect(block.contentHash).toBe(sha256Digest(block.serializedContent));
      expect(block.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
    expect(assembled.prefixHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("is stable for identical input", () => {
    const first = assembleContext(input());
    const second = assembleContext(input());
    expect(second.prefixHash).toBe(first.prefixHash);
  });

  it("changes the prefix when user content changes", () => {
    const first = assembleContext(input());
    const second = assembleContext(
      input({
        user: { messageId: "msg_01JABCDEFG", text: "different", attachments: [] },
      }),
    );
    expect(second.prefixHash).not.toBe(first.prefixHash);
  });

  it("omits empty optional blocks without reordering the rest", () => {
    const assembled = assembleContext(
      input({
        memory: undefined,
        task: undefined,
        transcript: [],
        monitor: { lines: [] },
        user: undefined,
      }),
    );
    expect(assembled.blocks.map((block) => block.blockId)).toEqual(["system", "tools"]);
  });

  it("rejects duplicate tool names and empty prompts", () => {
    expect(() =>
      assembleContext(
        input({
          tools: [
            { name: "read_file", summary: "a", inputSchema: {} },
            { name: "read_file", summary: "b", inputSchema: {} },
          ],
        }),
      ),
    ).toThrow(/duplicate tool/u);
    expect(() => assembleContext(input({ promptText: "   " }))).toThrow();
  });
});
