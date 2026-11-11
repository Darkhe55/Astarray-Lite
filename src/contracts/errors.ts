/**
 * Stable error contract for Astarray Lite.
 *
 * Codes are part of the public surface: UI, CLI and tests may switch on them.
 * Do not rename an existing code; add a new one and keep the old alias if needed.
 */

export const LITE_ERROR_CODES = [
  "LITE_INVALID_ARGUMENT",
  "LITE_NOT_IMPLEMENTED",
  "LITE_INTERNAL_ERROR",
  "LITE_LOCK_HELD",
  "LITE_STATE_CORRUPT",
  "LITE_SCHEMA_UNSUPPORTED",
  "LITE_RECOVERY_REQUIRED",
  "LITE_CONTEXT_BUDGET_EXCEEDED",
  "LITE_PROVIDER_AUTH_FAILED",
  "LITE_PROVIDER_RATE_LIMITED",
  "LITE_PROVIDER_CONTEXT_OVERFLOW",
  "LITE_PROVIDER_REQUEST_FAILED",
  "LITE_TURN_TIMEOUT",
  "LITE_TURN_BUDGET_EXHAUSTED",
  "LITE_TURN_CANCELLED",
  "LITE_TOOL_NOT_FOUND",
  "LITE_TOOL_DISABLED",
  "LITE_TOOL_SCHEMA_INVALID",
  "LITE_TOOL_EXECUTION_FAILED",
  "LITE_PERMISSION_DENIED",
  "LITE_PERMISSION_TIMEOUT",
  "LITE_PERMISSION_ASK_PENDING",
  "LITE_PATH_OUT_OF_WORKSPACE",
  "LITE_SENSITIVE_CONTENT_BLOCKED",
  "LITE_BACKUP_FAILED",
  "LITE_FILE_NOT_FOUND",
  "LITE_FILE_TOO_LARGE",
  "LITE_FILE_BINARY_UNSUPPORTED",
  "LITE_REPLACE_COUNT_MISMATCH",
  "LITE_SHELL_TIMEOUT",
  "LITE_SHELL_SANDBOX_UNAVAILABLE",
  "LITE_MONITOR_NOT_FOUND",
  "LITE_MONITOR_LIMIT_EXCEEDED",
  "LITE_MONITOR_SSRF_BLOCKED",
  "LITE_TASK_NOT_FOUND",
  "LITE_TASK_REVISION_CONFLICT",
  "LITE_TASK_QUEUE_EMPTY",
  "LITE_ACTIVE_TASK_PRESENT",
  "LITE_GOAL_OUTCOME_REQUIRED",
  "LITE_GOAL_OUTCOME_NOT_APPLICABLE",
  "LITE_GOAL_SITUATION_REQUIRED",
  "LITE_GOAL_CRITERIA_REQUIRED",
  "LITE_GOAL_CRITERIA_MISSING",
  "LITE_GOAL_REVIEW_RATE_LIMITED",
  "LITE_GOAL_HAS_ACTIVE_CHILDREN",
  "LITE_GOAL_UPDATE_REQUIRES_GOAL_REVIEW",
  "LITE_USER_MESSAGE_EMPTY",
  "LITE_USER_MESSAGE_TOO_LARGE",
  "LITE_USER_MESSAGE_ALREADY_RESOLVED",
  "LITE_USER_MESSAGE_NOT_FOUND",
  "LITE_NON_IDEMPOTENT_OUTCOME_UNKNOWN",
  "LITE_TOOL_PACKAGE_INVALID",
  "LITE_TOOL_PACKAGE_HASH_MISMATCH",
  "LITE_TOOL_PACKAGE_INSTALL_DENIED",
] as const;

export type LiteErrorCode = (typeof LITE_ERROR_CODES)[number];

export interface LiteErrorDetails {
  readonly [key: string]: unknown;
}

/**
 * Error type carried across the lite kernel boundary.
 *
 * `details` is intentionally unstructured: callers must not rely on internal
 * shapes, only on `code` and the human-readable `message`.
 */
export class LiteError extends Error {
  readonly code: LiteErrorCode;
  readonly details: LiteErrorDetails | undefined;

  constructor(code: LiteErrorCode, message: string, details?: LiteErrorDetails) {
    super(message);
    this.name = "LiteError";
    this.code = code;
    this.details = details;
  }
}

export function isLiteError(value: unknown): value is LiteError {
  return value instanceof LiteError;
}

export function toLiteError(value: unknown): LiteError {
  if (isLiteError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new LiteError("LITE_INTERNAL_ERROR", message);
}
