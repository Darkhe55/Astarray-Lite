import { canonicalJsonString } from "../context/canonical-json.js";

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  new RegExp(`${["gh", "p_"].join("")}[A-Za-z0-9]{20,}\\b`, "u"),
  new RegExp(`${["AK", "IA"].join("")}[0-9A-Z]{16}\\b`, "u"),
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
];

function redact(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/**
 * Produces a short, redacted summary for an approval prompt. It must not leak
 * secrets, full file contents, or machine-specific absolute paths.
 */
export function createSafePreview(toolName: string, argumentsValue: unknown): string {
  let serialized: string;
  try {
    serialized = canonicalJsonString(argumentsValue);
  } catch {
    serialized = "[unserializable arguments]";
  }
  const redacted = redact(serialized).replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+/gu, "[path]");
  const shortened = redacted.length <= 500 ? redacted : `${redacted.slice(0, 500)}...[truncated]`;
  return `${toolName} ${shortened}`;
}
