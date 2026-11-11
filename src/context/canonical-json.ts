import { LiteError } from "../contracts/errors.js";

function fail(message: string): never {
  throw new LiteError("LITE_INVALID_ARGUMENT", message);
}

function canonicalizeValue(value: unknown, stack: Set<object>): unknown {
  if (value === null) return null;
  const valueType = typeof value;

  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON does not allow non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    fail(`canonical JSON does not allow ${valueType}`);
  }
  if (valueType === "bigint") fail("canonical JSON does not allow bigint");

  if (Array.isArray(value)) {
    if (stack.has(value)) fail("canonical JSON does not allow circular arrays");
    stack.add(value);
    try {
      return value.map((entry) => canonicalizeValue(entry, stack));
    } finally {
      stack.delete(value);
    }
  }

  if (valueType === "object") {
    const objectValue = value as object;
    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("canonical JSON only accepts plain objects");
    }
    if (stack.has(objectValue)) fail("canonical JSON does not allow circular objects");
    stack.add(objectValue);
    try {
      const record = objectValue as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        const entry = record[key];
        if (entry === undefined) continue;
        result[key] = canonicalizeValue(entry, stack);
      }
      return result;
    } finally {
      stack.delete(objectValue);
    }
  }

  fail("canonical JSON received an unsupported value");
}

/**
 * Produces a deterministic JSON string: object keys are sorted recursively,
 * undefined object properties are omitted, arrays keep their declared order,
 * and non-plain objects are rejected.
 */
export function canonicalJsonString(value: unknown): string {
  const canonical = canonicalizeValue(value, new Set<object>());
  return JSON.stringify(canonical);
}
