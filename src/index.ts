/**
 * Astarray Lite public entry.
 *
 * This package is intentionally standalone: the kernel implementation will be
 * added incrementally. The contracts exported here are the stable surface an
 * embedding host and the UI can compile against.
 */

import type {
  LiteApplicationFacade,
  LiteApplicationOptions,
} from "./contracts/facade.js";
import { LiteError } from "./contracts/errors.js";

export const LITE_PACKAGE_NAME = "astarray-lite" as const;
export const LITE_PACKAGE_VERSION = "0.0.0" as const;

export * from "./contracts/capabilities.js";
export * from "./contracts/errors.js";
export * from "./contracts/events.js";
export * from "./contracts/facade.js";
export * from "./contracts/kernel-port.js";

/**
 * Scaffold only. The real factory is implemented with the kernel runtime.
 */
export async function createLiteApplication(
  options: LiteApplicationOptions,
): Promise<LiteApplicationFacade> {
  void options;
  throw new LiteError(
    "LITE_NOT_IMPLEMENTED",
    "Lite kernel is not implemented yet (scaffold).",
  );
}
