import { describe, expect, it } from "vitest";

import {
  activateNextTask,
  completeActiveTask,
  createEmptyTaskSequence,
  getRunnableTaskId,
  insertTask,
  removeTask,
  reorderTask,
  replaceActiveTask,
  validateTaskSequence,
  type LiteTaskSequence,
} from "../../src/tasks/task-sequence.js";

const now = "2026-01-01T00:00:00.000Z";

function insert(sequence: LiteTaskSequence, taskId: string): LiteTaskSequence {
  return insertTask(sequence, taskId, { kind: "bottom" }, now);
}

describe("task sequence", () => {
  it("inserts at top, bottom, before and after", () => {
    let sequence = createEmptyTaskSequence(now);
    sequence = insert(sequence, "a");
    sequence = insertTask(sequence, "b", { kind: "top" }, now);
    sequence = insertTask(sequence, "c", { kind: "before", taskId: "a" }, now);
    sequence = insertTask(sequence, "d", { kind: "after", taskId: "a" }, now);
    expect(sequence.pendingTaskIds).toEqual(["b", "c", "a", "d"]);
  });

  it("activates the first runnable pending task without changing order", () => {
    let sequence = createEmptyTaskSequence(now);
    sequence = insert(sequence, "goal-1");
    sequence = insert(sequence, "normal-1");
    sequence = activateNextTask(sequence, now, (taskId) => taskId !== "goal-1");
    expect(sequence.activeTaskId).toBe("normal-1");
    expect(sequence.pendingTaskIds).toEqual(["goal-1"]);
    expect(getRunnableTaskId(sequence, (taskId) => taskId !== "goal-1")).toBe("normal-1");
  });

  it("swaps the context slot on replace", () => {
    let sequence = createEmptyTaskSequence(now);
    sequence = insert(sequence, "a");
    sequence = insert(sequence, "b");
    sequence = activateNextTask(sequence, now);
    sequence = replaceActiveTask(sequence, "b", now);
    expect(sequence.activeTaskId).toBe("b");
    expect(sequence.pendingTaskIds).toEqual(["a"]);
  });

  it("reorders only pending tasks", () => {
    let sequence = createEmptyTaskSequence(now);
    sequence = insert(sequence, "a");
    sequence = insert(sequence, "b");
    sequence = insert(sequence, "c");
    sequence = reorderTask(sequence, "c", 0, now);
    expect(sequence.pendingTaskIds).toEqual(["c", "a", "b"]);
  });

  it("removes active and pending tasks", () => {
    let sequence = createEmptyTaskSequence(now);
    sequence = insert(sequence, "a");
    sequence = insert(sequence, "b");
    sequence = removeTask(sequence, "b", now);
    expect(sequence.pendingTaskIds).toEqual(["a"]);
    sequence = activateNextTask(sequence, now);
    sequence = removeTask(sequence, "a", now);
    expect(sequence.activeTaskId).toBeNull();
  });

  it("completes the active task", () => {
    let sequence = createEmptyTaskSequence(now);
    sequence = insert(sequence, "a");
    sequence = activateNextTask(sequence, now);
    sequence = completeActiveTask(sequence, now);
    expect(sequence.activeTaskId).toBeNull();
  });

  it("rejects duplicate ids and invalid states", () => {
    const sequence = createEmptyTaskSequence(now);
    expect(() => insertTask(sequence, "a", { kind: "bottom" }, now)).not.toThrow();
    expect(() =>
      insertTask({ ...sequence, pendingTaskIds: ["a"] }, "a", { kind: "bottom" }, now),
    ).toThrow(/already exists/u);
    expect(() =>
      validateTaskSequence({ ...sequence, activeTaskId: "a", pendingTaskIds: ["a"] }),
    ).toThrow(/active task/u);
  });

  it("preserves invariants across randomized operations", () => {
    let state = 0x12345678;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };

    let sequence = createEmptyTaskSequence(now);
    const ids = ["a", "b", "c", "d", "e"];
    for (let step = 0; step < 200; step += 1) {
      const operation = Math.floor(random() * 4);
      if (operation === 0) {
        const candidate = ids[Math.floor(random() * ids.length)];
        if (candidate !== undefined && !sequence.pendingTaskIds.includes(candidate) && sequence.activeTaskId !== candidate) {
          sequence = insertTask(sequence, candidate, { kind: "bottom" }, now);
        }
      } else if (operation === 1) {
        sequence = activateNextTask(sequence, now);
      } else if (operation === 2 && sequence.activeTaskId !== null) {
        sequence = completeActiveTask(sequence, now);
      } else if (sequence.pendingTaskIds.length > 1) {
        const taskId = sequence.pendingTaskIds[0];
        if (taskId !== undefined) {
          sequence = reorderTask(sequence, taskId, sequence.pendingTaskIds.length - 1, now);
        }
      }
      validateTaskSequence(sequence);
    }
  });
});
