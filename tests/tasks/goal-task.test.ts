import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  addChildToGoal,
  assertChildParentLink,
  createGoalTask,
  isGoalDue,
  normalizeGoalFields,
  validateGoalRecord,
} from "../../src/tasks/goal-task.js";
import { createTaskRecord } from "../../src/tasks/task-record.js";

const now = "2026-01-01T00:00:00.000Z";
const root = fileURLToPath(new URL("../../", import.meta.url));

describe("goal tasks", () => {
  it("requires situation and success criteria", () => {
    expect(() => normalizeGoalFields({ situation: " ", successCriteria: ["x"] })).toThrow(
      /situation/u,
    );
    expect(() => normalizeGoalFields({ situation: "s", successCriteria: [] })).toThrow(
      /criteria/u,
    );
    expect(() =>
      normalizeGoalFields({
        situation: "s",
        successCriteria: ["x"],
        reviewPolicy: { trigger: "interval" },
      }),
    ).toThrow(/intervalSeconds/u);
  });

  it("creates a goal task with normalized fields", () => {
    const goal = createGoalTask({
      title: "goal",
      objective: "reach the goal",
      goal: {
        situation: "current state",
        successCriteria: ["a", "a", "b"],
        reviewPolicy: { trigger: "manual" },
      },
      nowIso: now,
      taskId: "tsk_01JABCDEFG",
    });
    expect(goal.taskKind).toBe("goal");
    expect(goal.goal?.successCriteria).toEqual(["a", "b"]);
    expect(goal.goal?.childTaskIds).toEqual([]);
    validateGoalRecord(goal);
  });

  it("adds children without changing the parent goal fields", () => {
    const goal = createGoalTask({
      title: "goal",
      objective: "reach the goal",
      goal: { situation: "current", successCriteria: ["done"] },
      nowIso: now,
      taskId: "tsk_01JABCDEFG",
    });
    const linked = addChildToGoal(goal, "tsk_child", now);
    expect(linked.goal?.childTaskIds).toEqual(["tsk_child"]);
    expect(linked.goal?.situation).toBe(goal.goal?.situation);
    expect(linked.goal?.successCriteria).toEqual(goal.goal?.successCriteria);
    expect(() => addChildToGoal(linked, "tsk_child", now)).toThrow(/already linked/u);

    const child = {
      ...createTaskRecord({
        title: "child",
        objective: "child work",
        parentGoalId: "tsk_01JABCDEFG",
        nowIso: now,
        taskId: "tsk_child",
      }),
    };
    expect(() => assertChildParentLink(child, linked)).not.toThrow();
  });

  it("evaluates manual, interval and after-children due rules", () => {
    const base = createGoalTask({
      title: "goal",
      objective: "reach",
      goal: { situation: "s", successCriteria: ["c"] },
      nowIso: now,
    });
    expect(isGoalDue(base, { nowIso: now })).toBe(false);

    const interval = {
      ...base,
      goal: { ...base.goal!, reviewPolicy: { trigger: "interval" as const, intervalSeconds: 60 }, nextReviewAtIso: now },
    };
    expect(isGoalDue(interval, { nowIso: now })).toBe(true);

    const afterChildren = {
      ...base,
      goal: { ...base.goal!, reviewPolicy: { trigger: "after-children" as const }, childTaskIds: ["c1", "c2"] },
    };
    expect(isGoalDue(afterChildren, { nowIso: now, childStatuses: { c1: "done", c2: "running" } })).toBe(false);
    expect(isGoalDue(afterChildren, { nowIso: now, childStatuses: { c1: "done", c2: "stale" } })).toBe(true);
  });

  it("ships a goal-aware task record schema", async () => {
    const schema = JSON.parse(
      await readFile(path.join(root, "schemas", "task-record.schema.json"), "utf8"),
    ) as {
      properties: { taskKind: { enum: string[] } };
      allOf: Array<{ then: { required: string[] } }>;
    };
    expect(schema.properties.taskKind.enum).toEqual(["normal", "goal"]);
    expect(schema.allOf[0]?.then.required).toContain("goal");
  });
});
