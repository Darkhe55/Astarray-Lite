import { LiteError } from "../contracts/errors.js";
import {
  createTaskRecord,
  type CreateTaskInput,
  type LiteTaskGoal,
  type LiteTaskRecord,
} from "./task-record.js";

export interface GoalTaskInput {
  readonly situation: string;
  readonly successCriteria: readonly string[];
  readonly reviewPolicy?: {
    readonly trigger: "after-children" | "interval" | "manual";
    readonly intervalSeconds?: number;
  };
  readonly childTaskIds?: readonly string[];
  readonly nextReviewAtIso?: string;
}

export function normalizeGoalFields(input: GoalTaskInput): LiteTaskGoal {
  if (input.situation.trim() === "") {
    throw new LiteError("LITE_GOAL_SITUATION_REQUIRED", "goal situation is required");
  }
  if (input.successCriteria.length === 0 || input.successCriteria.some((criterion) => criterion.trim() === "")) {
    throw new LiteError("LITE_GOAL_CRITERIA_REQUIRED", "goal success criteria are required");
  }
  const reviewPolicy = input.reviewPolicy ?? { trigger: "manual" as const };
  if (reviewPolicy.trigger === "interval") {
    if (
      reviewPolicy.intervalSeconds === undefined ||
      !Number.isInteger(reviewPolicy.intervalSeconds) ||
      reviewPolicy.intervalSeconds < 1
    ) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "interval review policy requires intervalSeconds");
    }
  }
  return {
    goalState: "pursuing",
    situation: input.situation,
    successCriteria: [...new Set(input.successCriteria)],
    childTaskIds: [...new Set(input.childTaskIds ?? [])],
    reviewPolicy,
    reviewRequested: false,
    reviewCount: 0,
    noProgressReviewCount: 0,
    ...(input.nextReviewAtIso === undefined ? {} : { nextReviewAtIso: input.nextReviewAtIso }),
  };
}

export function createGoalTask(
  input: Omit<CreateTaskInput, "taskKind" | "goal"> & { readonly goal: GoalTaskInput },
): LiteTaskRecord {
  const goal = normalizeGoalFields(input.goal);
  return createTaskRecord({
    ...input,
    taskKind: "goal",
    goal,
  });
}

export function validateGoalRecord(record: LiteTaskRecord): void {
  if (record.taskKind !== "goal") return;
  if (record.goal === undefined) {
    throw new LiteError("LITE_GOAL_CRITERIA_REQUIRED", "goal task is missing goal fields");
  }
  const goal = record.goal;
  if (goal.situation.trim() === "") {
    throw new LiteError("LITE_GOAL_SITUATION_REQUIRED", "goal situation is required");
  }
  if (goal.successCriteria.length === 0) {
    throw new LiteError("LITE_GOAL_CRITERIA_REQUIRED", "goal success criteria are required");
  }
  if (new Set(goal.childTaskIds).size !== goal.childTaskIds.length) {
    throw new LiteError("LITE_STATE_CORRUPT", "goal child task ids must be unique");
  }
  if (goal.childTaskIds.includes(record.taskId)) {
    throw new LiteError("LITE_STATE_CORRUPT", "goal cannot be its own child");
  }
}

/**
 * Adds a child link to a goal without changing its situation, criteria or
 * review policy. The child record itself must carry `parentGoalId`.
 */
export function addChildToGoal(
  goal: LiteTaskRecord,
  childTaskId: string,
  nowIso: string,
): LiteTaskRecord {
  if (goal.taskKind !== "goal" || goal.goal === undefined) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "only goal tasks can own children");
  }
  if (childTaskId === goal.taskId) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "goal cannot be its own child");
  }
  if (goal.goal.childTaskIds.includes(childTaskId)) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "child task is already linked");
  }
  return {
    ...goal,
    revision: goal.revision + 1,
    updatedAtIso: nowIso,
    goal: {
      ...goal.goal,
      childTaskIds: [...goal.goal.childTaskIds, childTaskId],
    },
  };
}

export function assertChildParentLink(child: LiteTaskRecord, parent: LiteTaskRecord): void {
  if (child.parentGoalId !== parent.taskId) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "child parentGoalId does not match the parent goal");
  }
  if (parent.taskKind !== "goal") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "parent task is not a goal");
  }
  if (parent.goal === undefined || !parent.goal.childTaskIds.includes(child.taskId)) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "child is not linked from the goal");
  }
}

/**
 * A goal is due when its review policy says so. `after-children` assumes the
 * caller passes the current status of every child.
 */
export function isGoalDue(
  record: LiteTaskRecord,
  input: {
    readonly nowIso: string;
    readonly childStatuses?: Readonly<Record<string, string>>;
  },
): boolean {
  if (record.taskKind !== "goal" || record.goal === undefined) return false;
  const goal = record.goal;
  if (goal.goalState === "achieved" || goal.goalState === "abandoned") return false;
  if (goal.reviewRequested) return true;

  switch (goal.reviewPolicy.trigger) {
    case "manual":
      return false;
    case "interval":
      return goal.nextReviewAtIso !== undefined && goal.nextReviewAtIso <= input.nowIso;
    case "after-children": {
      const statuses = input.childStatuses ?? {};
      const children = goal.childTaskIds;
      if (children.length === 0) return false;
      return children.every((childId) => {
        const status = statuses[childId];
        return status === "done" || status === "stale" || status === "cancelled";
      });
    }
  }
}
