import { describe, expect, it } from "vitest";

import { assembleContext } from "../../src/context/context-assembler.js";
import { buildContextManifest } from "../../src/context/context-manifest.js";

const assembled = assembleContext({
  promptVersion: "lite-1.0",
  promptText: "system prompt",
  toolsetRevision: 1,
  tools: [{ name: "read_file", summary: "read", inputSchema: {} }],
  task: {
    taskId: "tsk_01JABCDEFG",
    revision: 4,
    taskKind: "goal",
    documentText: "goal document",
  },
});

describe("buildContextManifest", () => {
  it("builds a manifest with hashes, token counts and model metadata", () => {
    const manifest = buildContextManifest({
      assembled,
      turnId: "trn_01JABCDEFG",
      createdAtIso: "2026-01-01T00:00:00.000Z",
      providerId: "openai",
      modelIdentifier: "gpt-4.1",
      tokenBudget: 64_000,
      countTokens: (text) => text.length,
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.model).toEqual({ providerId: "openai", modelIdentifier: "gpt-4.1" });
    expect(manifest.prefixHash).toBe(assembled.prefixHash);
    expect(manifest.blocks).toHaveLength(assembled.blocks.length);
    expect(manifest.totalTokenCount).toBe(
      manifest.blocks.reduce((total, block) => total + block.tokenCount, 0),
    );
    expect(manifest.blocks.every((block) => block.truncated === false)).toBe(true);
    const taskBlock = manifest.blocks.find((block) => block.blockId === "task");
    expect(taskBlock?.sourceRevision).toBe(4);
  });

  it("rejects invalid turn ids and budgets", () => {
    expect(() =>
      buildContextManifest({
        assembled,
        turnId: " ",
        createdAtIso: "2026-01-01T00:00:00.000Z",
        providerId: "openai",
        modelIdentifier: "gpt-4.1",
        tokenBudget: 64_000,
        countTokens: (text) => text.length,
      }),
    ).toThrow();
    expect(() =>
      buildContextManifest({
        assembled,
        turnId: "trn_01JABCDEFG",
        createdAtIso: "2026-01-01T00:00:00.000Z",
        providerId: "openai",
        modelIdentifier: "gpt-4.1",
        tokenBudget: 0,
        countTokens: (text) => text.length,
      }),
    ).toThrow();
  });
});
