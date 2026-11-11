import { afterEach, describe, expect, it } from "vitest";

import { createLiteApplication } from "../../src/application/lite-application.js";
import { createGoalTask } from "../../src/tasks/goal-task.js";
import { createTaskRecord } from "../../src/tasks/task-record.js";
import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import {
  finalizeGoal,
  projectGoal,
  projectGoals,
} from "../../src/facade/goal-projection.js";
import { archiveTask } from "../../src/tasks/task-archive.js";
import { renderTaskMarkdown } from "../../src/tasks/task-document.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

function goal() {
  return createGoalTask({
    title: "Ship the report",
    objective: "Internal objective that must not leak",
    goal: {
      situation: "Quarterly data is ready but the report is missing",
      successCriteria: ["Report exists", "Tests pass"],
      childTaskIds: ["c1", "c2"],
    },
    nowIso: now,
    taskId: "tsk_goal",
  });
}

describe("goal projections", () => {
  it("returns only goals and omits ordinary task bodies", () => {
    const normal = createTaskRecord({
      title: "ordinary",
      objective: "ordinary body",
      nowIso: now,
      taskId: "tsk_normal",
    });
    const projections = projectGoals([goal(), normal]);
    expect(projections).toHaveLength(1);
    expect(projections[0]?.goalTaskId).toBe("tsk_goal");
    expect(JSON.stringify(projections)).not.toContain("Internal objective");
    expect(JSON.stringify(projections)).not.toContain("ordinary body");
  });

  it("summarizes situation, criteria and child counts", () => {
    const projection = projectGoal(goal(), {
      childStatuses: { c1: "done", c2: "running" },
    });
    expect(projection).toMatchObject({
      goalTaskId: "tsk_goal",
      goalState: "pursuing",
      successCriteriaCount: 2,
      childTaskCount: 2,
      pendingChildCount: 1,
    });
    expect(projection?.situationSummary).toContain("Quarterly data");
  });

  it("finalizes achieved goals as done and abandoned goals as stale", async () => {
    const achieved = finalizeGoal({
      record: goal(),
      outcome: "achieved",
      atIso: now,
      evidence: ["report.md"],
    });
    expect(achieved.record.status).toBe("done");
    expect(achieved.record.goal?.goalState).toBe("achieved");
    expect(achieved.archiveReason).toBe("completed");

    const abandoned = finalizeGoal({
      record: goal(),
      outcome: "abandoned",
      atIso: now,
    });
    expect(abandoned.record.status).toBe("stale");
    expect(abandoned.record.goal?.goalState).toBe("abandoned");
    expect(abandoned.archiveReason).toBe("stale");

    expect(() =>
      finalizeGoal({ record: goal(), outcome: "achieved", atIso: now }),
    ).toThrow(/evidence/u);

    const workspace = await createTestDirectory("goal-archive");
    directories.push(workspace);
    const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
    await archiveTask({
      paths,
      record: achieved.record,
      taskMarkdown: renderTaskMarkdown(achieved.record),
      archiveReason: achieved.archiveReason,
    });
  });

  it("exposes a read-only queryGoals facade method", async () => {
    const workspace = await createTestDirectory("goal-facade");
    directories.push(workspace);
    const app = await createLiteApplication({
      kernel: "lite",
      stateDirectory: ".astarray-lite",
      workspaceRootPath: workspace,
    });
    expect(await app.queryGoals()).toEqual([]);
  });
});
