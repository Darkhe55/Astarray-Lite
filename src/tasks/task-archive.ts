import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import type { LiteTokenUsage } from "../contracts/events.js";
import { assertSafePathSegment, type LitePaths } from "../persistence/lite-paths.js";
import { readJsonWithBackup, writeJsonAtomic } from "../persistence/state-store.js";
import type { LiteTaskRecord } from "./task-record.js";

export type TaskArchiveReason = "completed" | "stale" | "cancelled";

export interface TaskCompletionSnapshot {
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly criteriaResults: readonly string[];
  readonly selfAssessment: "good" | "needs-review" | "blocked";
  readonly goalOutcome?: "achieved" | "continue" | "abandoned";
}

export interface TaskArchiveRecord {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly archivedAtIso: string;
  readonly archiveReason: TaskArchiveReason;
  readonly record: LiteTaskRecord;
  readonly taskMarkdown: string;
  readonly completion?: TaskCompletionSnapshot;
  readonly durationMilliseconds: number;
  readonly tokenUsage: LiteTokenUsage;
  readonly reviewChain: readonly string[];
}

const STATUS_BY_REASON: Readonly<Record<TaskArchiveReason, LiteTaskRecord["status"]>> = {
  completed: "done",
  stale: "stale",
  cancelled: "cancelled",
};

const ZERO_USAGE: LiteTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export function resolveTaskArchivePath(paths: LitePaths, taskId: string): string {
  assertSafePathSegment(taskId, "taskId");
  return path.join(paths.archiveTasksDirectory, `${taskId}.json`);
}

/**
 * Writes the terminal archive record. The task directory is intentionally left
 * in place so the final documents remain inspectable; the archive is the
 * durable audit copy.
 */
export async function archiveTask(input: {
  readonly paths: LitePaths;
  readonly record: LiteTaskRecord;
  readonly taskMarkdown: string;
  readonly archiveReason: TaskArchiveReason;
  readonly archivedAtIso?: string;
  readonly completion?: TaskCompletionSnapshot;
  readonly tokenUsage?: LiteTokenUsage;
  readonly reviewChain?: readonly string[];
}): Promise<TaskArchiveRecord> {
  const expectedStatus = STATUS_BY_REASON[input.archiveReason];
  if (input.record.status !== expectedStatus) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "archive reason does not match task status", {
      taskId: input.record.taskId,
      status: input.record.status,
      archiveReason: input.archiveReason,
    });
  }
  const archivedAtIso = input.archivedAtIso ?? new Date().toISOString();
  const archive: TaskArchiveRecord = {
    schemaVersion: 1,
    taskId: input.record.taskId,
    archivedAtIso,
    archiveReason: input.archiveReason,
    record: input.record,
    taskMarkdown: input.taskMarkdown,
    ...(input.completion === undefined ? {} : { completion: input.completion }),
    durationMilliseconds: Math.max(
      0,
      Date.parse(archivedAtIso) - Date.parse(input.record.createdAtIso),
    ),
    tokenUsage: input.tokenUsage ?? ZERO_USAGE,
    reviewChain: input.reviewChain ?? [],
  };
  const archivePath = resolveTaskArchivePath(input.paths, input.record.taskId);
  await writeJsonAtomic(archivePath, `${archivePath}.bak`, archive);
  return archive;
}

export async function readTaskArchive(
  paths: LitePaths,
  taskId: string,
): Promise<TaskArchiveRecord | null> {
  const archivePath = resolveTaskArchivePath(paths, taskId);
  const result = await readJsonWithBackup<TaskArchiveRecord>(
    archivePath,
    `${archivePath}.bak`,
  );
  return result?.value ?? null;
}
