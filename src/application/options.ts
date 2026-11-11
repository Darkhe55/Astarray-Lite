import { LiteError } from "../contracts/errors.js";
import type { LiteApplicationOptions } from "../contracts/facade.js";

function assertNonEmpty(value: string | undefined, field: string): void {
  if (value === undefined || value.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
}

/**
 * Validates the host-supplied options before a kernel is created.
 *
 * Validation is intentionally local and side-effect free: it never creates a
 * directory or writes a file. Persistence starts later in the kernel lifecycle.
 */
export function validateLiteApplicationOptions(
  options: LiteApplicationOptions,
): LiteApplicationOptions {
  if (options.kernel !== "lite") {
    throw new LiteError("LITE_INVALID_ARGUMENT", 'kernel must be "lite"');
  }
  assertNonEmpty(options.stateDirectory, "stateDirectory");
  assertNonEmpty(options.workspaceRootPath, "workspaceRootPath");

  if (options.projectIdentifier !== undefined) {
    assertNonEmpty(options.projectIdentifier, "projectIdentifier");
  }
  if (options.sessionId !== undefined) {
    assertNonEmpty(options.sessionId, "sessionId");
  }

  const tick = options.kernelOptions?.listenerTickIntervalMilliseconds;
  if (tick !== undefined && (!Number.isInteger(tick) || tick < 100)) {
    throw new LiteError(
      "LITE_INVALID_ARGUMENT",
      "listenerTickIntervalMilliseconds must be an integer >= 100",
    );
  }

  const budget = options.kernelOptions?.contextTokenBudget;
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 4096)) {
    throw new LiteError(
      "LITE_INVALID_ARGUMENT",
      "contextTokenBudget must be an integer >= 4096",
    );
  }

  return options;
}
