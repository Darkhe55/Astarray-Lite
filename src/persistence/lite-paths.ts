import path from "node:path";

import { LiteError } from "../contracts/errors.js";

export interface LitePaths {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly stateFile: string;
  readonly stateBackupFile: string;
  readonly sequenceFile: string;
  readonly sequenceBackupFile: string;
  readonly inboxDirectory: string;
  readonly inboxJournalFile: string;
  readonly inboxIndexFile: string;
  readonly tasksDirectory: string;
  readonly archiveDirectory: string;
  readonly archiveUserMessagesDirectory: string;
  readonly archiveTasksDirectory: string;
  readonly memoryDirectory: string;
  readonly monitorsDirectory: string;
  readonly monitorDefinitionsFile: string;
  readonly monitorSamplesDirectory: string;
  readonly contextDirectory: string;
  readonly contextSnapshotsDirectory: string;
  readonly runsDirectory: string;
  readonly toolPackagesDirectory: string;
  readonly backupsDirectory: string;
  readonly backupObjectsDirectory: string;
  readonly backupManifestsDirectory: string;
  readonly locksDirectory: string;
  readonly lockFile: string;
  readonly auditFile: string;
  readonly metricsFile: string;
}

export interface ResolveLitePathsInput {
  readonly stateDirectory: string;
  readonly workspaceRootPath: string;
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolves the project-local state layout.
 *
 * `stateDirectory` may be absolute or relative to the workspace. It must be a
 * strict child of the workspace: the kernel never writes outside the project.
 */
export function resolveLitePaths(input: ResolveLitePathsInput): LitePaths {
  const workspaceRoot = path.resolve(input.workspaceRootPath);
  const stateRoot = path.isAbsolute(input.stateDirectory)
    ? path.resolve(input.stateDirectory)
    : path.resolve(workspaceRoot, input.stateDirectory);

  if (!isStrictlyInside(workspaceRoot, stateRoot)) {
    throw new LiteError(
      "LITE_PATH_OUT_OF_WORKSPACE",
      "stateDirectory must be a child of workspaceRootPath",
    );
  }

  return {
    workspaceRoot,
    stateRoot,
    stateFile: path.join(stateRoot, "state.json"),
    stateBackupFile: path.join(stateRoot, "state.json.bak"),
    sequenceFile: path.join(stateRoot, "sequence.json"),
    sequenceBackupFile: path.join(stateRoot, "sequence.json.bak"),
    inboxDirectory: path.join(stateRoot, "inbox"),
    inboxJournalFile: path.join(stateRoot, "inbox", "journal.jsonl"),
    inboxIndexFile: path.join(stateRoot, "inbox", "index.json"),
    tasksDirectory: path.join(stateRoot, "tasks"),
    archiveDirectory: path.join(stateRoot, "archive"),
    archiveUserMessagesDirectory: path.join(stateRoot, "archive", "user-messages"),
    archiveTasksDirectory: path.join(stateRoot, "archive", "tasks"),
    memoryDirectory: path.join(stateRoot, "memory"),
    monitorsDirectory: path.join(stateRoot, "monitors"),
    monitorDefinitionsFile: path.join(stateRoot, "monitors", "definitions.json"),
    monitorSamplesDirectory: path.join(stateRoot, "monitors", "samples"),
    contextDirectory: path.join(stateRoot, "context"),
    contextSnapshotsDirectory: path.join(stateRoot, "context", "snapshots"),
    runsDirectory: path.join(stateRoot, "runs"),
    toolPackagesDirectory: path.join(stateRoot, "tool-packages"),
    backupsDirectory: path.join(stateRoot, "backups"),
    backupObjectsDirectory: path.join(stateRoot, "backups", "objects"),
    backupManifestsDirectory: path.join(stateRoot, "backups", "manifests"),
    locksDirectory: path.join(stateRoot, "locks"),
    lockFile: path.join(stateRoot, "locks", "kernel.lock"),
    auditFile: path.join(stateRoot, "audit.jsonl"),
    metricsFile: path.join(stateRoot, "metrics.jsonl"),
  };
}

const WINDOWS_RESERVED_SEGMENTS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Validates a single path segment (task id, monitor id, run id) before it is
 * joined into a filesystem path.
 */
export function assertSafePathSegment(value: string, field: string): void {
  if (value.length === 0 || value.length > 128) {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be 1-128 characters`);
  }
  if (value === "." || value === "..") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must not be a relative segment`);
  }
  if (/[/\\\u0000-\u001f]/u.test(value)) {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} contains an unsafe character`);
  }
  if (WINDOWS_RESERVED_SEGMENTS.has(value.toLowerCase())) {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} is a reserved Windows name`);
  }
}
