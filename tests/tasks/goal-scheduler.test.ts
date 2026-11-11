import { describe, expect, it } from "vitest";

import {
  isReviewRateLimited,
  moveGoalAfterChildren,
  planGoalSchedule,
} from "../../src/tasks/goal-scheduler.js";
import { applyGoalReview } from "../../src/tasks/goal-review.js";
import { createGoalTask } from "../../src/tasks/goal-task.js";
import { createTaskRecord } from "../../src/tasks/task-record.js";
import { createEmptyTaskSequence } from "../../src/tasks/task-sequence.js";

const now = "2026-01-01T00:00:00.000Z";

function goal(overrides: { readonly childTaskIds?: readonly string[]; readonly trigger?: "after-children" | "interval" | "manual" } = {}) {
  return createGoalTask({
    title: "goal",
    objective: "reach it",
    goal: {
      situation: "current",
      successCriteria: ["done"],
      reviewPolicy: { trigger: overrides.trigger ?? "manual" },
      ...(overrides.childTaskIds === undefined ? {} : { childTaskIds: overrides.childTaskIds }),
    },
    nowIso: now,
    taskId: "tsk_goal",
  });
}

function normal(taskId: string) {
  return createTaskRecord({
    title: taskId,
    objective: taskId,
    nowIso: now,
    taskId,
  });
}

function sequenceFor(pendingTaskIds: readonly string[]) {
  return {
    ...createEmptyTaskSequence(now),
    pendingTaskIds: [...pendingTaskIds],
  };
}

describe("goal scheduler", () => {
  it("skips non-due goals and runs ordinary tasks", () => {
    const records = new Map([
      ["tsk_goal", goal()],
      ["tsk_normal", normal("tsk_normal")],
    ]);
    const plan = planGoalSchedule({
      sequence: sequenceFor(["tsk_goal", "tsk_normal"]),
      records,
      nowIso: now,
    });
    expect(plan.runnableTaskId).toBe("tsk_normal");
    expect(plan.skippedGoalIds).toEqual(["tsk_goal"]);
    expect(plan.idle).toBe(false);
  });

  it("stays idle when every task is a skipped goal", () => {
    const plan = planGoalSchedule({
      sequence: sequenceFor(["tsk_goal"]),
      records: new Map([["tsk_goal", goal()]]),
      nowIso: now,
    });
    expect(plan.idle).toBe(true);
    expect(plan.runnableTaskId).toBeNull();
  });

  it("makes a goal due when all children are terminal", () => {
    const goalRecord = goal({ childTaskIds: ["c1", "c2"], trigger: "after-children" });
    const plan = planGoalSchedule({
      sequence: sequenceFor(["tsk_goal"]),
      records: new Map([["tsk_goal", goalRecord]]),
      nowIso: now,
      childStatuses: { c1: "done", c2: "done" },
    });
    expect(plan.dueGoalIds).toEqual(["tsk_goal"]);
    expect(plan.runnableTaskId).toBe("tsk_goal");
  });

  it("rate limits reviews above twelve per hour", () => {
    const timestamps = Array.from({ length: 12 }, () => now);
    expect(isReviewRateLimited(timestamps, now)).toBe(true);
    const plan = planGoalSchedule({
      sequence: sequenceFor(["tsk_goal"]),
      records: new Map([["tsk_goal", goal({ childTaskIds: ["c1"], trigger: "after-children" })]]),
      nowIso: now,
      childStatuses: { c1: "done" },
      reviewTimestampsIso: timestamps,
    });
    expect(plan.rateLimited).toBe(true);
    expect(plan.idle).toBe(true);
  });

  it("moves a reviewed goal after its last pending child", () => {
    const sequence = sequenceFor(["tsk_goal", "c1", "x", "c2", "y"]);
    const moved = moveGoalAfterChildren(sequence, "tsk_goal", ["c1", "c2"], now);
    expect(moved.pendingTaskIds).toEqual(["c1", "x", "c2", "tsk_goal", "y"]);
  });
});

describe("goal review", () => {
  it("blocks after three reviews without progress", () => {
    let record = goal();
    for (let index = 0; index < 2; index += 1) {
      const result = applyGoalReview({ record, hadProgress: false, atIso: now });
      expect(result.blocked).toBe(false);
      record = result.record;
    }
    const third = applyGoalReview({ record, hadProgress: false, atIso: now });
    expect(third.blocked).toBe(true);
    expect(third.record.status).toBe("blocked");
    expect(third.record.blockedReason).toContain("no progress");
  });

  it("resets the no-progress counter when progress is made", () => {
    let record = goal();
    record = applyGoalReview({ record, hadProgress: false, atIso: now }).record;
    record = applyGoalReview({ record, hadProgress: false, atIso: now }).record;
    const progress = applyGoalReview({ record, hadProgress: true, atIso: now });
    expect(progress.record.goal?.noProgressReviewCount).toBe(0);
    expect(progress.blocked).toBe(false);
  });

  it("does not mutate the record when rate limited", () => {
    const record = goal();
    const result = applyGoalReview({
      record,
      hadProgress: true,
      atIso: now,
      reviewTimestampsIso: Array.from({ length: 12 }, () => now),
    });
    expect(result.rateLimited).toBe(true);
    expect(result.record).toBe(record);
  });
});
