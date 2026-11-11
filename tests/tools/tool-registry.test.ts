import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { LiteToolSpec } from "../../src/tools/tool-types.js";

function spec(overrides: Partial<LiteToolSpec> = {}): LiteToolSpec {
  return {
    name: "echo",
    summary: "echo text",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: true,
    requiresBackup: false,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    handler: async (argumentsValue) => ({
      outputText: String((argumentsValue as { text?: unknown }).text ?? ""),
    }),
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("registers, sorts and exposes context definitions", () => {
    const registry = new ToolRegistry();
    registry.register(spec({ name: "write_file", summary: "write" }));
    registry.register(spec({ name: "read_file", summary: "read" }));
    expect(registry.list().map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
    expect(registry.getContextDefinitions().map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
    ]);
    expect(registry.getRevision()).toBeGreaterThan(1);
    expect(registry.getDefinitionsHash()).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects duplicate and invalid tool names", () => {
    const registry = new ToolRegistry();
    registry.register(spec());
    expect(() => registry.register(spec())).toThrow(/already registered/u);
    expect(() => registry.register(spec({ name: "bad name" }))).toThrow(/name is invalid/u);
  });

  it("disables and re-enables tools", () => {
    const registry = new ToolRegistry();
    registry.register(spec());
    registry.disable("echo");
    expect(registry.isEnabled("echo")).toBe(false);
    expect(registry.list()).toHaveLength(0);
    expect(registry.list({ includeDisabled: true })).toHaveLength(1);
    expect(() => registry.require("echo")).toThrow(/disabled/u);
    registry.enable("echo");
    expect(registry.require("echo").name).toBe("echo");
  });

  it("reports unknown tools", () => {
    const registry = new ToolRegistry();
    expect(() => registry.require("missing")).toThrow(/not found/u);
    expect(registry.unregister("missing")).toBe(false);
  });
});
