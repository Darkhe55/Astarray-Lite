import { LiteError } from "../contracts/errors.js";
import { isGoalDue } from "./goal-task.js";
import type { LiteTaskRecord } from "./task-record.js";
import type { LiteTaskSequence } from "./task-sequence.js";

export interface GoalScheduleInput {
  readonly sequence: LiteTaskSequence;
  readonly records: ReadonlyMap<string, LiteTaskRecord>;
  readonly nowIso: string;
  readonly childStatuses?: Readonly<Record<string, string>>;
  readonly reviewTimestampsIso?: readonly string[];
  readonly maximumReviewsPerHour?: number;
}

export interface GoalSchedulePlan {
  readonly runnableTaskId: string | null;
  readonly dueGoalIds: readonly string[];
  readonly skippedGoalIds: readonly string[];
  readonly idle: boolean;
  readonly rateLimited: boolean;
}

export function isReviewRateLimited(
  timestampsIso: readonly string[],
  nowIso: string,
  maximumReviewsPerHour = 12,
): boolean {
  const now = Date.parse(nowIso);
  const windowStart = now - 60 * 60 * 1_000;
  const recent = timestampsIso.filter((timestamp) => {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) && parsed > windowStart && parsed <= now;
  });
  return recent.length >= maximumReviewsPerHour;
}

/**
 * Chooses the next normal task while treating goals as skippable anchors.
 * Non-due goals never block ordinary work; if everything is skipped the kernel
 * stays idle without a provider request.
 */
export function planGoalSchedule(input: GoalScheduleInput): GoalSchedulePlan {
  const rateLimited = isReviewRateLimited(
    input.reviewTimestampsIso ?? [],
    input.nowIso,
    input.maximumReviewsPerHour ?? 12,
  );
  const dueGoalIds: string[] = [];
  const skippedGoalIds: string[] = [];
  let runnableTaskId: string | null = null;

  for (const taskId of input.sequence.pendingTaskIds) {
    const record = input.records.get(taskId);
    if (record === undefined) {
      skippedGoalIds.push(taskId);
      continue;
    }
    if (record.taskKind === "goal") {
      if (isGoalDue(record, { nowIso: input.nowIso, childStatuses: input.childStatuses })) {
        dueGoalIds.push(taskId);
        if (!rateLimited && runnableTaskId === null) runnableTaskId = taskId;
      } else {
        skippedGoalIds.push(taskId);
      }
      continue;
    }
    if (runnableTaskId === null) runnableTaskId = taskId;
  }

  const idle = runnableTaskId === null;
  return { runnableTaskId, dueGoalIds, skippedGoalIds, idle, rateLimited };
}

/**
 * Returns a reviewed goal to the queue after its last linked child, or to the
 * tail when no child is currently pending. It never duplicates the goal.
 */
export function moveGoalAfterChildren(
  sequence: LiteTaskSequence,
  goalId: string,
  childTaskIds: readonly string[],
  nowIso: string,
): LiteTaskSequence {
  if (sequence.activeTaskId === goalId) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "active goals cannot be reordered");
  }
  const pending = sequence.pendingTaskIds.filter((taskId) => taskId !== goalId);
  if (pending.length === sequence.pendingTaskIds.length) {
    throw new LiteError("LITE_TASK_NOT_FOUND", "goal is not pending");
  }
  let lastChildIndex = -1;
  for (const childId of childTaskIds) {
    const index = pending.indexOf(childId);
    if (index > lastChildIndex) lastChildIndex = index;
  }
  const insertAt = lastChildIndex < 0 ? pending.length : lastChildIndex + 1;
  pending.splice(insertAt, 0, goalId);
  return {
    schemaVersion: 1,
    revision: sequence.revision + 1,
    activeTaskId: sequence.activeTaskId,
    pendingTaskIds: pending,
    updatedAtIso: nowIso,
  };
}
