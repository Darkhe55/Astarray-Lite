import { LiteError } from "../contracts/errors.js";
import type { LiteTaskRecord } from "../tasks/task-record.js";

export interface LiteGoalProjection {
  readonly goalTaskId: string;
  readonly title: string;
  readonly goalState: "pursuing" | "waiting" | "achieved" | "abandoned";
  readonly status: LiteTaskRecord["status"];
  readonly situationSummary: string;
  readonly successCriteriaCount: number;
  readonly childTaskCount: number;
  readonly pendingChildCount: number;
  readonly updatedAtIso: string;
}

const NON_TERMINAL_STATUSES = new Set(["pending", "active", "running", "blocked"]);

function summarize(value: string, maximum = 200): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}...`;
}

export function projectGoal(
  record: LiteTaskRecord,
  options: {
    readonly childStatuses?: Readonly<Record<string, string>> | undefined;
  } = {},
): LiteGoalProjection | null {
  if (record.taskKind !== "goal" || record.goal === undefined) return null;
  const childIds = record.goal.childTaskIds;
  const pendingChildCount =
    options.childStatuses === undefined
      ? childIds.length
      : childIds.filter((childId) => {
          const status = options.childStatuses?.[childId];
          return status !== undefined && NON_TERMINAL_STATUSES.has(status);
        }).length;
  return {
    goalTaskId: record.taskId,
    title: record.title,
    goalState: record.goal.goalState,
    status: record.status,
    situationSummary: summarize(record.goal.situation),
    successCriteriaCount: record.goal.successCriteria.length,
    childTaskCount: childIds.length,
    pendingChildCount,
    updatedAtIso: record.updatedAtIso,
  };
}

/**
 * Read-only projection for the goal list. It deliberately omits objective,
 * acceptance criteria text, task documents and progress notes so ordinary task
 * content does not leak through the goal view.
 */
export function projectGoals(
  records: readonly LiteTaskRecord[],
  options: {
    readonly childStatuses?: Readonly<Record<string, string>> | undefined;
  } = {},
): readonly LiteGoalProjection[] {
  return records
    .map((record) => projectGoal(record, options))
    .filter((projection): projection is LiteGoalProjection => projection !== null)
    .sort((left, right) => right.updatedAtIso.localeCompare(left.updatedAtIso));
}

export type GoalTerminalOutcome = "achieved" | "abandoned";

export interface FinalizedGoal {
  readonly record: LiteTaskRecord;
  readonly archiveReason: "completed" | "stale";
}

/**
 * Marks a goal achieved/abandoned. Achievement requires evidence; abandonment
 * keeps the review chain and archives as stale. The caller persists the record
 * and calls `archiveTask`.
 */
export function finalizeGoal(input: {
  readonly record: LiteTaskRecord;
  readonly outcome: GoalTerminalOutcome;
  readonly atIso: string;
  readonly evidence?: readonly string[];
}): FinalizedGoal {
  if (input.record.taskKind !== "goal" || input.record.goal === undefined) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "only goal tasks can be finalized");
  }
  if (input.outcome === "achieved" && (input.evidence ?? []).length === 0) {
    throw new LiteError("LITE_GOAL_CRITERIA_MISSING", "goal achievement requires evidence");
  }
  const goal = {
    ...input.record.goal,
    ...(input.outcome === "achieved"
      ? { goalState: "achieved" as const, achievedAtIso: input.atIso }
      : { goalState: "abandoned" as const, abandonedAtIso: input.atIso }),
  };
  return {
    record: {
      ...input.record,
      status: input.outcome === "achieved" ? "done" : "stale",
      revision: input.record.revision + 1,
      updatedAtIso: input.atIso,
      goal,
      ...(input.outcome === "achieved"
        ? { completedAtIso: input.atIso, archivedAtIso: input.atIso }
        : { archivedAtIso: input.atIso }),
      archiveReason: input.outcome === "achieved" ? "completed" : "stale",
    },
    archiveReason: input.outcome === "achieved" ? "completed" : "stale",
  };
}
