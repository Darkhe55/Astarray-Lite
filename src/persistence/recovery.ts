import { promises as fs } from "node:fs";

import { LiteError } from "../contracts/errors.js";
import type { LiteKernelStatus } from "../contracts/events.js";
import { KERNEL_TRANSITIONS } from "../kernel/state-machine.js";
import type { LitePaths } from "./lite-paths.js";
import { readJsonWithBackup, writeJsonAtomic } from "./state-store.js";
import { TaskSequenceStore } from "../tasks/task-sequence-store.js";
import { UserInbox } from "../inbox/user-inbox.js";

export interface LitePersistedState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly status: LiteKernelStatus;
  readonly updatedAtIso: string;
}

export interface RecoveryAction {
  readonly target: "state" | "sequence" | "inbox";
  readonly action:
    | "created"
    | "restored-from-backup"
    | "rebuilt-index"
    | "unchanged"
    | "skipped-dry-run";
  readonly detail: string;
}

export interface RecoveryReport {
  readonly healthy: boolean;
  readonly actions: readonly RecoveryAction[];
  readonly warnings: readonly string[];
}

const KNOWN_STATUSES = new Set<string>(Object.keys(KERNEL_TRANSITIONS));

function validatePersistedState(value: unknown): LitePersistedState {
  if (value === null || typeof value !== "object") {
    throw new LiteError("LITE_STATE_CORRUPT", "state file is not an object");
  }
  const state = value as Record<string, unknown>;
  if (state["schemaVersion"] !== 1) {
    throw new LiteError("LITE_SCHEMA_UNSUPPORTED", "unsupported state schema version");
  }
  if (typeof state["revision"] !== "number" || !Number.isInteger(state["revision"]) || state["revision"] < 1) {
    throw new LiteError("LITE_STATE_CORRUPT", "state revision must be a positive integer");
  }
  if (typeof state["status"] !== "string" || !KNOWN_STATUSES.has(state["status"])) {
    throw new LiteError("LITE_STATE_CORRUPT", "state status is invalid");
  }
  if (typeof state["updatedAtIso"] !== "string" || state["updatedAtIso"] === "") {
    throw new LiteError("LITE_STATE_CORRUPT", "state updatedAtIso is invalid");
  }
  return state as unknown as LitePersistedState;
}

function createDefaultState(nowIso: string): LitePersistedState {
  return {
    schemaVersion: 1,
    revision: 1,
    status: "booting",
    updatedAtIso: nowIso,
  };
}

/**
 * Rebuilds or validates the durable kernel state.
 *
 * The journal is authoritative for the inbox; the sequence and state files are
 * restored from `.bak` when possible. A corrupt journal is never silently
 * discarded: recovery fails closed with `LITE_RECOVERY_REQUIRED`.
 */
export async function recoverLiteState(input: {
  readonly paths: LitePaths;
  readonly now?: () => Date;
  readonly isDryRun?: boolean;
}): Promise<RecoveryReport> {
  const now = input.now ?? (() => new Date());
  const isDryRun = input.isDryRun ?? false;
  const actions: RecoveryAction[] = [];
  const warnings: string[] = [];
  const nowIso = now().toISOString();

  if (!isDryRun) {
    await fs.mkdir(input.paths.stateRoot, { recursive: true });
  }

  try {
    const stateResult = await readJsonWithBackup<LitePersistedState>(
      input.paths.stateFile,
      input.paths.stateBackupFile,
    );
    if (stateResult === null) {
      if (isDryRun) {
        actions.push({ target: "state", action: "skipped-dry-run", detail: "state file is missing" });
      } else {
        await writeJsonAtomic(
          input.paths.stateFile,
          input.paths.stateBackupFile,
          createDefaultState(nowIso),
        );
        actions.push({ target: "state", action: "created", detail: "default state created" });
      }
    } else {
      validatePersistedState(stateResult.value);
      if (stateResult.source === "backup" && !isDryRun) {
        await writeJsonAtomic(
          input.paths.stateFile,
          input.paths.stateBackupFile,
          stateResult.value,
        );
        actions.push({
          target: "state",
          action: "restored-from-backup",
          detail: "primary state was corrupt; backup restored",
        });
      } else {
        actions.push({ target: "state", action: "unchanged", detail: "state is valid" });
      }
    }
  } catch (error) {
    throw new LiteError("LITE_RECOVERY_REQUIRED", "state recovery failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const sequenceStore = new TaskSequenceStore(input.paths);
    const sequenceResult = await sequenceStore.readWithSource();
    if (sequenceResult.source === "empty") {
      if (isDryRun) {
        actions.push({
          target: "sequence",
          action: "skipped-dry-run",
          detail: "sequence file is missing",
        });
      } else {
        await sequenceStore.initialize(nowIso);
        actions.push({ target: "sequence", action: "created", detail: "empty sequence created" });
      }
    } else if (sequenceResult.source === "backup" && !isDryRun) {
      await sequenceStore.write(sequenceResult.sequence);
      actions.push({
        target: "sequence",
        action: "restored-from-backup",
        detail: "primary sequence was corrupt; backup restored",
      });
    } else {
      actions.push({ target: "sequence", action: "unchanged", detail: "sequence is valid" });
    }
  } catch (error) {
    throw new LiteError("LITE_RECOVERY_REQUIRED", "task sequence recovery failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const inbox = new UserInbox({
      paths: input.paths,
      now,
      isIndexWriteEnabled: !isDryRun,
    });
    await inbox.load();
    actions.push({
      target: "inbox",
      action: isDryRun ? "unchanged" : "rebuilt-index",
      detail: `replayed ${inbox.list().length} user messages`,
    });
  } catch (error) {
    throw new LiteError("LITE_RECOVERY_REQUIRED", "user inbox recovery failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    healthy: warnings.length === 0,
    actions,
    warnings,
  };
}
