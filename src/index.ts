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
export * from "./context/canonical-json.js";
export * from "./context/context-assembler.js";
export * from "./context/context-manifest.js";
export * from "./context/hash.js";
export * from "./context/token-budget.js";
export * from "./persistence/journal.js";
export * from "./persistence/lite-paths.js";
export * from "./persistence/lock.js";
export * from "./persistence/recovery.js";
export * from "./persistence/state-store.js";
export * from "./kernel/state-machine.js";
export * from "./kernel/listener-loop.js";
export * from "./kernel/task-loop.js";
export * from "./kernel/turn-arbiter.js";
export * from "./kernel/preemption.js";
export * from "./runtime/fake-provider.js";
export * from "./runtime/provider.js";
export * from "./runtime/provider-turn-runner.js";
export * from "./runtime/retry-policy.js";
export * from "./runtime/usage-budget.js";
export * from "./tools/tool-types.js";
export * from "./tools/tool-schema.js";
export * from "./tools/tool-registry.js";
export * from "./tools/tool-executor.js";
export * from "./tools/builtin/path-safety.js";
export * from "./tools/builtin/backup-store.js";
export * from "./tools/builtin/file-tools.js";
export * from "./tools/builtin/shell-policy.js";
export * from "./tools/builtin/shell-tool.js";
export * from "./tools/builtin/reply-tools.js";
export * from "./tools/builtin/task-tools.js";
export * from "./messages/message-slot.js";
export * from "./messages/reply-store.js";
export * from "./messages/user-turn.js";
export * from "./permissions/capabilities.js";
export * from "./permissions/ask-store.js";
export * from "./permissions/safe-preview.js";
export * from "./permissions/permission-manager.js";
export * from "./tasks/task-sequence.js";
export * from "./tasks/task-sequence-store.js";
export * from "./tasks/task-record.js";
export * from "./tasks/task-store.js";
export * from "./tasks/task-document.js";
export * from "./tasks/task-archive.js";
export * from "./tasks/completion-verifier.js";
export * from "./tasks/goal-task.js";
export * from "./tasks/goal-scheduler.js";
export * from "./tasks/goal-review.js";
export * from "./inbox/user-message.js";
export * from "./inbox/user-inbox.js";
