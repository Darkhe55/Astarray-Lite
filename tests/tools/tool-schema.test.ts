import { describe, expect, it } from "vitest";

import {
  sanitizeToolOutput,
  scanToolArguments,
  validateToolArguments,
} from "../../src/tools/tool-schema.js";

describe("validateToolArguments", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["read", "write"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
    },
    required: ["path"],
    additionalProperties: false,
  };

  it("accepts a matching object", () => {
    expect(
      validateToolArguments(schema, { path: "a.txt", mode: "read", limit: 10, tags: ["x"] }),
    ).toEqual({ valid: true, issues: [] });
  });

  it("reports missing, extra and mistyped fields", () => {
    const result = validateToolArguments(schema, { mode: "delete", limit: 0, extra: true });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["$.path", "$.mode", "$.limit", "$.extra"]),
    );
  });

  it("validates arrays and string patterns", () => {
    const result = validateToolArguments(
      {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[a-z]+$" },
          items: { type: "array", items: { type: "string" }, minItems: 2 },
        },
        required: ["name", "items"],
      },
      { name: "ABC", items: ["one"] },
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["$.name", "$.items"]),
    );
  });
});

const githubTokenPrefix = ["gh", "p_"].join("");
const privateKeyMarker = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");

describe("scanToolArguments", () => {
  it("accepts ordinary arguments", () => {
    expect(() => scanToolArguments({ path: "src/index.ts", text: "hello" })).not.toThrow();
  });

  it("rejects secret material", () => {
    expect(() => scanToolArguments({ text: `${githubTokenPrefix}${"a".repeat(30)}` })).toThrow(/secret/u);
    expect(() => scanToolArguments({ text: privateKeyMarker })).toThrow(/secret/u);
  });

  it("rejects absolute and traversing paths", () => {
    const absolute = ["C:", "tmp", "file.txt"].join("\\");
    expect(() => scanToolArguments({ path: absolute })).toThrow(/workspace-relative/u);
    expect(() => scanToolArguments({ path: "../outside.txt" })).toThrow(/traverse/u);
  });
});

describe("sanitizeToolOutput", () => {
  it("strips ANSI and redacts secrets", () => {
    const result = sanitizeToolOutput(
      `\u001b[31mred\u001b[0m ${githubTokenPrefix}${"a".repeat(30)}`,
      1_000,
    );
    expect(result.text).toBe("red [REDACTED]");
    expect(result.truncated).toBe(false);
  });

  it("truncates with a marker", () => {
    const result = sanitizeToolOutput("x".repeat(100), 20);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("[truncated]")).toBe(true);
    expect(result.text.length).toBe(20);
  });
});
