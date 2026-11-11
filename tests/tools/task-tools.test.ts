import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { UserInbox } from "../../src/inbox/user-inbox.js";
import { MessageSlot } from "../../src/messages/message-slot.js";
import { UserTurnController } from "../../src/messages/user-turn.js";
import { resolveLitePaths, type LitePaths } from "../../src/persistence/lite-paths.js";
import { registerTaskTools } from "../../src/tools/builtin/task-tools.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { readTaskArchive } from "../../src/tasks/task-archive.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(): Promise<{
  readonly workspace: string;
  readonly paths: LitePaths;
  readonly store: TaskStore;
  readonly inbox: UserInbox;
  readonly userTurn: UserTurnController;
  readonly executor: ToolExecutor;
}> {
  const workspace = await createTestDirectory("task-tools");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  const store = new TaskStore({ now: () => new Date(now) });
  const inbox = new UserInbox({ paths, now: () => new Date(now) });
  const userTurn = new UserTurnController(new MessageSlot(inbox));
  const registry = new ToolRegistry();
  registerTaskTools(registry, { paths, taskStore: store, userTurn, now: () => new Date(now) });
  return { workspace, paths, store, inbox, userTurn, executor: new ToolExecutor({ registry }) };
}

function call(
  executor: ToolExecutor,
  toolName: string,
  argumentsValue: unknown,
): Promise<import("../../src/tools/tool-types.js").LiteToolExecutionResult> {
  return executor.execute({
    callId: "call-1",
    toolName,
    argumentsJson: JSON.stringify(argumentsValue),
  });
}

describe("task tools", () => {
  it("inserts, lists, reads top and swaps the active task", async () => {
    const { store, executor } = await setup();
    const first = await call(executor, "task_insert", {
      position: "bottom",
      title: "first",
      objective: "do first",
    });
    const second = await call(executor, "task_insert", {
      position: "bottom",
      title: "second",
      objective: "do second",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const list = await call(executor, "task_list", {});
    expect(JSON.parse(list.outputText)).toHaveLength(2);

    const active = await call(executor, "task_read_top", {});
    expect(JSON.parse(active.outputText).title).toBe("first");
    const replaced = await call(executor, "task_read_top", { forceReplace: true });
    expect(JSON.parse(replaced.outputText).title).toBe("second");
    expect(store.getSequence().pendingTaskIds).toHaveLength(1);
  });

  it("updates with revision checks and reorders pending tasks", async () => {
    const { store, executor } = await setup();
    await call(executor, "task_insert", { position: "bottom", title: "a", objective: "a" });
    await call(executor, "task_insert", { position: "bottom", title: "b", objective: "b" });
    const [a, b] = store.list();
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    const updated = await call(executor, "task_update", {
      taskId: a?.taskId,
      expectedRevision: a?.revision,
      patch: { title: "a2" },
    });
    expect(JSON.parse(updated.outputText).title).toBe("a2");
    const conflict = await call(executor, "task_update", {
      taskId: a?.taskId,
      expectedRevision: a?.revision,
      patch: { title: "a3" },
    });
    expect(conflict.errorCode).toBe("LITE_TASK_REVISION_CONFLICT");

    const reordered = await call(executor, "task_reorder", {
      taskId: b?.taskId,
      toIndex: 0,
    });
    expect(JSON.parse(reordered.outputText).pendingTaskIds[0]).toBe(b?.taskId);
  });

  it("completes the active task and archives it", async () => {
    const { paths, executor } = await setup();
    await call(executor, "task_insert", { position: "bottom", title: "ship", objective: "ship it" });
    await call(executor, "task_read_top", {});
    const result = await call(executor, "task_complete", {
      summary: "shipped the report",
      evidence: [{ kind: "file", reference: "report.md", summary: "report" }],
      selfAssessment: "good",
    });
    expect(result.ok).toBe(true);
    const taskId = JSON.parse(result.outputText).taskId as string;
    expect((await readTaskArchive(paths, taskId))?.archiveReason).toBe("completed");
    expect(await fs.stat(`${paths.tasksDirectory}/${taskId}`).then(() => true, () => false)).toBe(true);
  });

  it("marks the active task stale", async () => {
    const { paths, executor } = await setup();
    await call(executor, "task_insert", { position: "bottom", title: "old", objective: "old" });
    await call(executor, "task_read_top", {});
    const result = await call(executor, "mark_task_stale", {
      disposition: "cancelled",
      reason: "no longer needed",
    });
    expect(result.ok).toBe(true);
    const taskId = JSON.parse(result.outputText).taskId as string;
    expect((await readTaskArchive(paths, taskId))?.archiveReason).toBe("cancelled");
  });

  it("rejects incomplete completion and creates a review task for needs-review", async () => {
    const { store, executor } = await setup();
    const inserted = await call(executor, "task_insert", {
      position: "bottom",
      title: "ship",
      objective: "ship it",
      acceptanceCriteria: ["report exists"],
    });
    const taskId = JSON.parse(inserted.outputText).taskId as string;
    await call(executor, "task_read_top", {});

    const rejected = await call(executor, "task_complete", {
      summary: "shipped the report",
      selfAssessment: "good",
    });
    expect(rejected.errorCode).toBe("LITE_COMPLETION_INCOMPLETE");
    expect(store.list()[0]?.status).toBe("active");

    const accepted = await call(executor, "task_complete", {
      summary: "shipped the report",
      evidence: [{ kind: "file", reference: "report.md", summary: "report" }],
      criteriaResults: [{ criterionIndex: 0, result: "met", evidenceRef: "report.md" }],
      selfAssessment: "needs-review",
    });
    expect(accepted.ok).toBe(true);
    expect(store.list()[0]?.reviewOfTaskId).toBe(taskId);
  });

  it("binds task creation to the active user message", async () => {
    const { inbox, userTurn, store, executor } = await setup();
    const message = await inbox.enqueue({ text: "please create a task" });
    await userTurn.admitNext();
    const result = await call(executor, "task_insert", {
      position: "bottom",
      title: "from user",
      objective: "do it",
      sourceMessageId: message.messageId,
    });
    expect(result.ok).toBe(true);
    const task = store.list()[0];
    expect(task?.source.kind).toBe("user");
    expect(task?.source.messageId).toBe(message.messageId);

    const resolved = await userTurn.finalize();
    expect(resolved?.disposition).toBe("converted-to-task");
    expect(resolved?.createdTaskIds).toEqual([task?.taskId]);
  });
});
