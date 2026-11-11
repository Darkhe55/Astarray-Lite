import { LiteError } from "../contracts/errors.js";

export type LiteTaskKind = "normal" | "goal";

export type LiteTaskRecordStatus =
  | "pending"
  | "active"
  | "running"
  | "blocked"
  | "done"
  | "stale"
  | "cancelled";

export type TerminalTaskRecordStatus = Extract<LiteTaskRecordStatus, "done" | "stale" | "cancelled">;

export interface LiteTaskSequence {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly activeTaskId: string | null;
  readonly pendingTaskIds: readonly string[];
  readonly updatedAtIso: string;
}

export type TaskInsertPosition =
  | { readonly kind: "top" }
  | { readonly kind: "bottom" }
  | { readonly kind: "before"; readonly taskId: string }
  | { readonly kind: "after"; readonly taskId: string };

export function isTerminalTaskRecordStatus(status: LiteTaskRecordStatus): status is TerminalTaskRecordStatus {
  return status === "done" || status === "stale" || status === "cancelled";
}

export function createEmptyTaskSequence(nowIso: string): LiteTaskSequence {
  return {
    schemaVersion: 1,
    revision: 1,
    activeTaskId: null,
    pendingTaskIds: [],
    updatedAtIso: nowIso,
  };
}

function assertTaskId(value: string, field: string): void {
  if (value.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be non-empty`);
  }
}

/**
 * Validates structural invariants. When `taskStatusById` is supplied it also
 * checks that active/pending tasks exist and are not terminal.
 */
export function validateTaskSequence(
  sequence: LiteTaskSequence,
  taskStatusById?: ReadonlyMap<string, LiteTaskRecordStatus>,
): void {
  if (sequence.schemaVersion !== 1) {
    throw new LiteError("LITE_SCHEMA_UNSUPPORTED", "unsupported task sequence schema version");
  }
  if (!Number.isInteger(sequence.revision) || sequence.revision < 1) {
    throw new LiteError("LITE_STATE_CORRUPT", "task sequence revision must be a positive integer");
  }
  if (sequence.activeTaskId !== null) {
    assertTaskId(sequence.activeTaskId, "activeTaskId");
    if (sequence.pendingTaskIds.includes(sequence.activeTaskId)) {
      throw new LiteError(
        "LITE_STATE_CORRUPT",
        "active task must not also appear in pendingTaskIds",
      );
    }
  }

  const seen = new Set<string>();
  for (const taskId of sequence.pendingTaskIds) {
    assertTaskId(taskId, "pendingTaskIds[]");
    if (seen.has(taskId)) {
      throw new LiteError("LITE_STATE_CORRUPT", `duplicate pending task id: ${taskId}`);
    }
    seen.add(taskId);
    if (sequence.activeTaskId === taskId) {
      throw new LiteError("LITE_STATE_CORRUPT", "active task appears in pendingTaskIds");
    }
  }

  if (taskStatusById === undefined) return;

  if (sequence.activeTaskId !== null) {
    const status = taskStatusById.get(sequence.activeTaskId);
    if (status === undefined) {
      throw new LiteError("LITE_STATE_CORRUPT", "active task record is missing");
    }
    if (isTerminalTaskRecordStatus(status)) {
      throw new LiteError("LITE_STATE_CORRUPT", "active task is already terminal");
    }
  }
  for (const taskId of sequence.pendingTaskIds) {
    const status = taskStatusById.get(taskId);
    if (status === undefined) {
      throw new LiteError("LITE_STATE_CORRUPT", `pending task record is missing: ${taskId}`);
    }
    if (isTerminalTaskRecordStatus(status)) {
      throw new LiteError("LITE_STATE_CORRUPT", `pending task is terminal: ${taskId}`);
    }
  }
}

function nextSequence(
  sequence: LiteTaskSequence,
  nowIso: string,
  activeTaskId: string | null,
  pendingTaskIds: readonly string[],
): LiteTaskSequence {
  const next: LiteTaskSequence = {
    schemaVersion: 1,
    revision: sequence.revision + 1,
    activeTaskId,
    pendingTaskIds,
    updatedAtIso: nowIso,
  };
  validateTaskSequence(next);
  return next;
}

/**
 * Activates the first runnable pending task. A non-runnable task (for example a
 * goal that is not due) is skipped without changing queue order.
 */
export function activateNextTask(
  sequence: LiteTaskSequence,
  nowIso: string,
  isRunnable: (taskId: string) => boolean = () => true,
): LiteTaskSequence {
  if (sequence.activeTaskId !== null) return sequence;
  const index = sequence.pendingTaskIds.findIndex((taskId) => isRunnable(taskId));
  if (index < 0) return sequence;
  const taskId = sequence.pendingTaskIds[index];
  if (taskId === undefined) return sequence;
  const pending = [...sequence.pendingTaskIds];
  pending.splice(index, 1);
  return nextSequence(sequence, nowIso, taskId, pending);
}

export function insertTask(
  sequence: LiteTaskSequence,
  taskId: string,
  position: TaskInsertPosition,
  nowIso: string,
): LiteTaskSequence {
  assertTaskId(taskId, "taskId");
  if (sequence.activeTaskId === taskId || sequence.pendingTaskIds.includes(taskId)) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "task already exists in the sequence");
  }

  const pending = [...sequence.pendingTaskIds];
  if (position.kind === "top") {
    pending.unshift(taskId);
  } else if (position.kind === "bottom") {
    pending.push(taskId);
  } else if (position.kind === "before" || position.kind === "after") {
    if (position.taskId === sequence.activeTaskId) {
      pending.unshift(taskId);
    } else {
      const index = pending.indexOf(position.taskId);
      if (index < 0) {
        throw new LiteError("LITE_TASK_NOT_FOUND", `position target not found: ${position.taskId}`);
      }
      pending.splice(position.kind === "before" ? index : index + 1, 0, taskId);
    }
  }

  return nextSequence(sequence, nowIso, sequence.activeTaskId, pending);
}

export function removeTask(
  sequence: LiteTaskSequence,
  taskId: string,
  nowIso: string,
): LiteTaskSequence {
  if (sequence.activeTaskId === taskId) {
    return nextSequence(sequence, nowIso, null, sequence.pendingTaskIds);
  }
  if (!sequence.pendingTaskIds.includes(taskId)) {
    throw new LiteError("LITE_TASK_NOT_FOUND", `task not found: ${taskId}`);
  }
  return nextSequence(
    sequence,
    nowIso,
    sequence.activeTaskId,
    sequence.pendingTaskIds.filter((candidate) => candidate !== taskId),
  );
}

export function reorderTask(
  sequence: LiteTaskSequence,
  taskId: string,
  toIndex: number,
  nowIso: string,
): LiteTaskSequence {
  const index = sequence.pendingTaskIds.indexOf(taskId);
  if (index < 0) {
    throw new LiteError("LITE_TASK_NOT_FOUND", `pending task not found: ${taskId}`);
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= sequence.pendingTaskIds.length) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "toIndex is out of range");
  }
  const pending = [...sequence.pendingTaskIds];
  pending.splice(index, 1);
  pending.splice(toIndex, 0, taskId);
  return nextSequence(sequence, nowIso, sequence.activeTaskId, pending);
}

export function completeActiveTask(
  sequence: LiteTaskSequence,
  nowIso: string,
): LiteTaskSequence {
  if (sequence.activeTaskId === null) {
    throw new LiteError("LITE_TASK_NOT_FOUND", "there is no active task");
  }
  return nextSequence(sequence, nowIso, null, sequence.pendingTaskIds);
}

/**
 * Swaps the context slot: the old active task returns to the pending head and
 * the selected pending task becomes active.
 */
export function replaceActiveTask(
  sequence: LiteTaskSequence,
  newTaskId: string,
  nowIso: string,
): LiteTaskSequence {
  const previousActive = sequence.activeTaskId;
  if (previousActive === null) {
    throw new LiteError("LITE_TASK_NOT_FOUND", "there is no active task to replace");
  }
  if (newTaskId === previousActive) {
    return sequence;
  }
  if (!sequence.pendingTaskIds.includes(newTaskId)) {
    throw new LiteError("LITE_TASK_NOT_FOUND", `pending task not found: ${newTaskId}`);
  }
  const pending = [previousActive, ...sequence.pendingTaskIds.filter((id) => id !== newTaskId)];
  return nextSequence(sequence, nowIso, newTaskId, pending);
}

export function getRunnableTaskId(
  sequence: LiteTaskSequence,
  isRunnable: (taskId: string) => boolean,
): string | null {
  if (sequence.activeTaskId !== null && isRunnable(sequence.activeTaskId)) {
    return sequence.activeTaskId;
  }
  return sequence.pendingTaskIds.find((taskId) => isRunnable(taskId)) ?? null;
}

