import { describe, expect, it } from "vitest";

import { TaskStore } from "../../src/tasks/task-store.js";

const now = "2026-01-01T00:00:00.000Z";

function store(): TaskStore {
  return new TaskStore({ now: () => new Date(now) });
}

async function insert(storeValue: TaskStore, title: string): Promise<string> {
  const task = await storeValue.insertTask({
    title,
    objective: `objective ${title}`,
    nowIso: now,
  });
  return task.taskId;
}

describe("TaskStore", () => {
  it("promotes the queue head and swaps on forceReplace", async () => {
    const tasks = store();
    const first = await insert(tasks, "first");
    const second = await insert(tasks, "second");
    const third = await insert(tasks, "third");

    const active = await tasks.readTop();
    expect(active.taskId).toBe(first);
    expect(tasks.getSequence().activeTaskId).toBe(first);
    expect(tasks.getSequence().pendingTaskIds).toEqual([second, third]);
    expect(tasks.getTask(first)?.status).toBe("active");

    await expect(tasks.readTop(false)).rejects.toMatchObject({ code: "LITE_ACTIVE_TASK_PRESENT" });
    const replaced = await tasks.readTop(true);
    expect(replaced.taskId).toBe(second);
    expect(tasks.getSequence().pendingTaskIds).toEqual([first, third]);
    expect(tasks.getTask(first)?.status).toBe("pending");
    expect(tasks.getTask(second)?.status).toBe("active");
  });

  it("inserts at top, bottom, before and after", async () => {
    const tasks = store();
    const first = await insert(tasks, "first");
    const third = await insert(tasks, "third");
    const second = await tasks.insertTask(
      { title: "second", objective: "objective second", nowIso: now },
      { kind: "before", taskId: third },
    );
    const zeroth = await tasks.insertTask(
      { title: "zeroth", objective: "objective zeroth", nowIso: now },
      { kind: "top" },
    );
    expect(tasks.getSequence().pendingTaskIds).toEqual([
      zeroth.taskId,
      first,
      second.taskId,
      third,
    ]);
  });

  it("reorders only pending tasks", async () => {
    const tasks = store();
    const first = await insert(tasks, "first");
    const second = await insert(tasks, "second");
    const third = await insert(tasks, "third");
    await tasks.readTop();
    await tasks.reorderTask(third, 0);
    expect(tasks.getSequence().pendingTaskIds).toEqual([third, second]);
    await expect(tasks.reorderTask(first, 0)).rejects.toMatchObject({ code: "LITE_TASK_NOT_FOUND" });
  });

  it("enforces expectedRevision on updates", async () => {
    const tasks = store();
    const taskId = await insert(tasks, "first");
    const initial = tasks.getTask(taskId);
    expect(initial).toBeDefined();
    const updated = await tasks.updateTask({
      taskId,
      patch: { title: "renamed" },
      expectedRevision: initial?.revision ?? 0,
    });
    expect(updated.title).toBe("renamed");
    await expect(
      tasks.updateTask({
        taskId,
        patch: { title: "again" },
        expectedRevision: initial?.revision ?? 0,
      }),
    ).rejects.toMatchObject({
      code: "LITE_TASK_REVISION_CONFLICT",
      details: expect.objectContaining({ latestRevision: 2 }),
    });
  });

  it("lists active then pending and removes tasks", async () => {
    const tasks = store();
    const first = await insert(tasks, "first");
    const second = await insert(tasks, "second");
    await tasks.readTop();
    expect(tasks.list().map((task) => task.taskId)).toEqual([first, second]);
    await tasks.removeTask(second);
    expect(tasks.getSequence().pendingTaskIds).toEqual([]);
  });

  it("returns queue empty when there is nothing to promote", async () => {
    const tasks = store();
    await expect(tasks.readTop()).rejects.toMatchObject({ code: "LITE_TASK_QUEUE_EMPTY" });
  });
});
