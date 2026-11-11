import type { LiteGoalProjection } from "./goal-projection.js";
import type { LiteTaskRecord } from "../tasks/task-record.js";
import type { LiteKernelSnapshot } from "../contracts/kernel-port.js";

export interface GuiTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: LiteTaskRecord["status"];
  readonly taskKind: LiteTaskRecord["taskKind"];
}

export interface GuiStateProjection {
  readonly kernel: "lite";
  readonly status: LiteKernelSnapshot["status"];
  readonly sessionId: string;
  readonly tasks: readonly GuiTaskRow[];
  readonly goals: readonly LiteGoalProjection[];
}

export function projectGuiTasks(tasks: readonly LiteTaskRecord[]): readonly GuiTaskRow[] {
  return tasks.map((task) => ({
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    taskKind: task.taskKind,
  }));
}

export function projectGuiState(input: {
  readonly snapshot: LiteKernelSnapshot;
  readonly tasks: readonly LiteTaskRecord[];
  readonly goals: readonly LiteGoalProjection[];
}): GuiStateProjection {
  return {
    kernel: "lite",
    status: input.snapshot.status,
    sessionId: input.snapshot.sessionId,
    tasks: projectGuiTasks(input.tasks),
    goals: input.goals,
  };
}
