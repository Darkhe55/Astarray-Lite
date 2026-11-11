import { describe, expect, it } from "vitest";

import { canonicalJsonString } from "../../src/context/canonical-json.js";

describe("canonicalJsonString", () => {
  it("sorts object keys recursively and keeps array order", () => {
    const canonical = canonicalJsonString({
      z: 1,
      a: { b: 2, a: 1 },
      list: [{ y: 2, x: 1 }, 3],
    });
    expect(canonical).toBe('{"a":{"a":1,"b":2},"list":[{"x":1,"y":2},3],"z":1}');
  });

  it("omits undefined object properties", () => {
    expect(canonicalJsonString({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("normalizes negative zero", () => {
    expect(canonicalJsonString({ value: -0 })).toBe('{"value":0}');
  });

  it("rejects unsupported values", () => {
    expect(() => canonicalJsonString(undefined)).toThrow();
    expect(() => canonicalJsonString(Number.NaN)).toThrow();
    expect(() => canonicalJsonString(10n)).toThrow();
    expect(() => canonicalJsonString(new Date())).toThrow();
    expect(() => canonicalJsonString(() => undefined)).toThrow();
  });

  it("rejects circular structures", () => {
    const value: Record<string, unknown> = {};
    value["self"] = value;
    expect(() => canonicalJsonString(value)).toThrow();
  });

  it("is stable across repeated calls", () => {
    const value = { b: [{ d: 2, c: 1 }], a: "x" };
    expect(canonicalJsonString(value)).toBe(canonicalJsonString(value));
  });
});
