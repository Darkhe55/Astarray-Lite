import { LiteError } from "../contracts/errors.js";
import { canonicalJsonString } from "../context/canonical-json.js";

export interface ToolSchemaIssue {
  readonly path: string;
  readonly message: string;
}

export interface ToolSchemaValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ToolSchemaIssue[];
}

type SchemaRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateNode(
  schema: unknown,
  value: unknown,
  path: string,
  issues: ToolSchemaIssue[],
): void {
  if (schema === true) return;
  if (schema === false) {
    issues.push({ path, message: "value is not allowed" });
    return;
  }
  if (!isPlainObject(schema)) {
    issues.push({ path, message: "schema is not an object" });
    return;
  }

  const expectedType = schema["type"];
  if (expectedType !== undefined) {
    const types = Array.isArray(expectedType) ? expectedType : [expectedType];
    const matched = types.some((type) => matchesType(type, value));
    if (!matched) {
      issues.push({ path, message: `expected ${types.join(" or ")}` });
      return;
    }
  }

  if (Array.isArray(schema["enum"])) {
    const serialized = canonicalJsonString(value);
    const allowed = schema["enum"].some((entry) => {
      try {
        return canonicalJsonString(entry) === serialized;
      } catch {
        return false;
      }
    });
    if (!allowed) issues.push({ path, message: "value is not in the allowed enum" });
  }

  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      issues.push({ path, message: "string is too short" });
    }
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
      issues.push({ path, message: "string is too long" });
    }
    if (typeof schema["pattern"] === "string") {
      try {
        if (!new RegExp(schema["pattern"], "u").test(value)) {
          issues.push({ path, message: "string does not match the required pattern" });
        }
      } catch {
        issues.push({ path, message: "schema pattern is invalid" });
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      issues.push({ path, message: "number is below the minimum" });
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      issues.push({ path, message: "number is above the maximum" });
    }
  }

  if (Array.isArray(value)) {
    if (schema["items"] !== undefined) {
      value.forEach((entry, index) => {
        validateNode(schema["items"], entry, `${path}[${index}]`, issues);
      });
    }
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) {
      issues.push({ path, message: "array has too few items" });
    }
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) {
      issues.push({ path, message: "array has too many items" });
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        issues.push({ path: `${path}.${key}`, message: "required property is missing" });
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key in properties) {
        validateNode(properties[key], entry, `${path}.${key}`, issues);
      } else if (schema["additionalProperties"] === false) {
        issues.push({ path: `${path}.${key}`, message: "additional property is not allowed" });
      }
    }
  }
}

function matchesType(type: unknown, value: unknown): boolean {
  if (typeof type !== "string") return false;
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

export function validateToolArguments(
  schema: unknown,
  value: unknown,
): ToolSchemaValidationResult {
  const issues: ToolSchemaIssue[] = [];
  validateNode(schema, value, "$", issues);
  return { valid: issues.length === 0, issues };
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  new RegExp(`${["gh", "p_"].join("")}[A-Za-z0-9]{20,}\\b`, "u"),
  new RegExp(`${["AK", "IA"].join("")}[0-9A-Z]{16}\\b`, "u"),
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
];

const PATH_ARGUMENT_KEYS = new Set([
  "path",
  "filePath",
  "cwd",
  "targetPath",
  "sourcePath",
  "destinationPath",
  "root",
]);

function assertSafeString(value: string, key: string | null, argumentPath: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      throw new LiteError("LITE_SENSITIVE_CONTENT_BLOCKED", "tool arguments contain secret material", {
        argumentPath,
      });
    }
  }
  if (key === null || !PATH_ARGUMENT_KEYS.has(key)) return;
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value)) {
    throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "tool path must be workspace-relative", {
      argumentPath,
    });
  }
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)) {
    throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "tool path must not traverse parents", {
      argumentPath,
    });
  }
}

function scanValue(value: unknown, key: string | null, argumentPath: string): void {
  if (typeof value === "string") {
    assertSafeString(value, key, argumentPath);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanValue(entry, key, `${argumentPath}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [entryKey, entry] of Object.entries(value)) {
      scanValue(entry, entryKey, `${argumentPath}.${entryKey}`);
    }
  }
}

/**
 * Rejects obvious secret material and workspace-escaping path arguments before
 * a tool touches the filesystem or process.
 */
export function scanToolArguments(value: unknown): void {
  scanValue(value, null, "$");
}

export function sanitizeToolOutput(
  text: string,
  maximumCharacters: number,
): { readonly text: string; readonly truncated: boolean } {
  const withoutAnsi = text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
  let redacted = withoutAnsi;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  if (redacted.length <= maximumCharacters) {
    return { text: redacted, truncated: false };
  }
  const marker = "\n[truncated]";
  const keep = Math.max(0, maximumCharacters - marker.length);
  return { text: `${redacted.slice(0, keep)}${marker}`, truncated: true };
}
