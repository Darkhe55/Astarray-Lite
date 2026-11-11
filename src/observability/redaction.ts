const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`${["gh", "p_"].join("")}[A-Za-z0-9]{20,}`, "gu"),
  new RegExp(`${["AK", "IA"].join("")}[0-9A-Z]{16}`, "gu"),
  /\bsk-[A-Za-z0-9]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
];

const PATH_PATTERNS: readonly RegExp[] = [
  /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/gu,
  /(?:^|[\s"'(])\/(?:home|Users|var|tmp|opt)\/[^\s"')]+/gu,
];

const SENSITIVE_KEY_PATTERN = /(?:key|token|secret|password|passwd|credential|authorization|cookie)/iu;

export function redactText(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  for (const pattern of PATH_PATTERNS) result = result.replace(pattern, "[PATH]");
  return result;
}

/**
 * Single redaction funnel for logs, archives and event journals. It preserves
 * shape while removing secret material, sensitive keys and absolute paths.
 */
export function redactValue(value: unknown, key: string | null = null): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key));
  if (typeof value === "object") {
    const record: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(entryKey)) {
        record[entryKey] = "[REDACTED]";
      } else {
        record[entryKey] = redactValue(entry, entryKey);
      }
    }
    return record;
  }
  return String(value);
}
