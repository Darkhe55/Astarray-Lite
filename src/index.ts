/**
 * Astarray Lite public entry.
 *
 * This package is intentionally standalone: the kernel implementation will be
 * added incrementally. The contracts exported here are the stable surface an
 * embedding host and the UI can compile against.
 */

export const LITE_PACKAGE_NAME = "astarray-lite" as const;
export const LITE_PACKAGE_VERSION = "0.0.0" as const;

export * from "./contracts/capabilities.js";
export * from "./contracts/errors.js";
export * from "./contracts/events.js";
export * from "./contracts/facade.js";
export * from "./contracts/identifiers.js";
export * from "./contracts/kernel-port.js";
export * from "./application/lite-application.js";
export * from "./application/options.js";
export * from "./persistence/journal.js";
export * from "./persistence/lite-paths.js";
export * from "./persistence/lock.js";
export * from "./persistence/recovery.js";
export * from "./persistence/state-store.js";
export * from "./kernel/state-machine.js";
export * from "./kernel/listener-loop.js";
export * from "./kernel/task-loop.js";
export * from "./kernel/turn-arbiter.js";
export * from "./tasks/task-sequence.js";
export * from "./tasks/task-sequence-store.js";
export * from "./inbox/user-message.js";
export * from "./inbox/user-inbox.js";
