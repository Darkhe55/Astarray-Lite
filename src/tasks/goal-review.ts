import { LiteError } from "../contracts/errors.js";
import type { LiteTaskRecord } from "./task-record.js";
import { isReviewRateLimited } from "./goal-scheduler.js";

export interface GoalReviewResult {
  readonly record: LiteTaskRecord;
  readonly blocked: boolean;
  readonly rateLimited: boolean;
}

/**
 * Applies one goal review. Three consecutive reviews without progress block the
 * goal; progress resets the counter. More than twelve reviews per hour is rate
 * limited and leaves the record untouched.
 */
export function applyGoalReview(input: {
  readonly record: LiteTaskRecord;
  readonly hadProgress: boolean;
  readonly atIso: string;
  readonly nextReviewAtIso?: string;
  readonly reviewTimestampsIso?: readonly string[];
  readonly maximumReviewsPerHour?: number;
}): GoalReviewResult {
  if (input.record.taskKind !== "goal" || input.record.goal === undefined) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "only goal tasks can be reviewed");
  }
  if (
    input.record.goal.goalState === "achieved" ||
    input.record.goal.goalState === "abandoned"
  ) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "goal is already closed");
  }
  if (
    isReviewRateLimited(
      input.reviewTimestampsIso ?? [],
      input.atIso,
      input.maximumReviewsPerHour ?? 12,
    )
  ) {
    return { record: input.record, blocked: false, rateLimited: true };
  }

  const noProgressReviewCount = input.hadProgress
    ? 0
    : input.record.goal.noProgressReviewCount + 1;
  const blocked = noProgressReviewCount >= 3;
  const goal = {
    ...input.record.goal,
    goalState: blocked ? ("waiting" as const) : ("pursuing" as const),
    reviewRequested: false,
    reviewCount: input.record.goal.reviewCount + 1,
    noProgressReviewCount,
    lastReviewedAtIso: input.atIso,
    ...(input.nextReviewAtIso === undefined
      ? {}
      : { nextReviewAtIso: input.nextReviewAtIso }),
  };
  const record: LiteTaskRecord = {
    ...input.record,
    revision: input.record.revision + 1,
    updatedAtIso: input.atIso,
    goal,
    status: blocked ? "blocked" : input.record.status,
    blockedReason: blocked ? "goal made no progress across three reviews" : undefined,
  };
  return { record, blocked, rateLimited: false };
}
