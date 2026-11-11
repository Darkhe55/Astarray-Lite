import { LiteError } from "../contracts/errors.js";
import type { LiteTaskRecord } from "../tasks/task-record.js";

export type PreemptionPhase = "idle" | "provider" | "tool-batch";

export type PreemptionDecision = "continue" | "tool-batch" | "preempt";

export type TaskTurnOutcome = "completed" | "interrupted" | "failed";

export interface PreemptionSnapshot {
  readonly phase: PreemptionPhase;
  readonly taskId: string | null;
  readonly pendingInterrupt: boolean;
  readonly consecutiveIncompleteTurns: number;
  readonly blocked: boolean;
}

export const RESUME_PROMPT =
  "继续执行活动任务；先读任务文档的“进度/未决问题”，不要重复已完成步骤。";

/**
 * Safe-point preemption for a task turn.
 *
 * A user message never aborts an in-flight provider stream or tool batch; it
 * is latched and observed before the next provider call or after the current
 * tool batch. Twenty consecutive incomplete turns block the task.
 */
export class PreemptionController {
  private phase: PreemptionPhase = "idle";
  private taskId: string | null = null;
  private pendingInterrupt = false;
  private consecutiveIncompleteTurns = 0;
  private blocked = false;
  private readonly maximumIncompleteTurns: number;

  constructor(options: { readonly maximumIncompleteTurns?: number } = {}) {
    this.maximumIncompleteTurns = options.maximumIncompleteTurns ?? 20;
    if (!Number.isInteger(this.maximumIncompleteTurns) || this.maximumIncompleteTurns < 1) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "maximumIncompleteTurns must be positive");
    }
  }

  beginTaskTurn(taskId: string): void {
    if (this.phase !== "idle") {
      throw new LiteError("LITE_INTERNAL_ERROR", "a task turn is already in flight");
    }
    if (this.blocked) {
      throw new LiteError("LITE_PERMISSION_DENIED", "task is blocked after repeated incomplete turns");
    }
    this.taskId = taskId;
    this.phase = "provider";
    this.pendingInterrupt = false;
  }

  requestInterrupt(): boolean {
    if (this.phase === "idle") return false;
    this.pendingInterrupt = true;
    return true;
  }

  beforeProviderCall(): PreemptionDecision {
    if (this.pendingInterrupt) return "preempt";
    if (this.phase !== "provider") return "continue";
    return "continue";
  }

  afterProviderResponse(hasToolCalls: boolean): PreemptionDecision {
    if (hasToolCalls) {
      this.phase = "tool-batch";
      return "tool-batch";
    }
    if (this.pendingInterrupt) return "preempt";
    this.phase = "provider";
    return "continue";
  }

  afterToolBatch(): PreemptionDecision {
    this.phase = "provider";
    if (this.pendingInterrupt) return "preempt";
    return "continue";
  }

  endTaskTurn(outcome: TaskTurnOutcome): void {
    if (this.phase === "idle") return;
    this.phase = "idle";
    this.taskId = null;
    this.pendingInterrupt = false;
    if (outcome === "completed") {
      this.consecutiveIncompleteTurns = 0;
      return;
    }
    this.consecutiveIncompleteTurns += 1;
    if (this.consecutiveIncompleteTurns >= this.maximumIncompleteTurns) {
      this.blocked = true;
    }
  }

  resumeTask(): void {
    this.blocked = false;
    this.consecutiveIncompleteTurns = 0;
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  getSnapshot(): PreemptionSnapshot {
    return {
      phase: this.phase,
      taskId: this.taskId,
      pendingInterrupt: this.pendingInterrupt,
      consecutiveIncompleteTurns: this.consecutiveIncompleteTurns,
      blocked: this.blocked,
    };
  }
}

/**
 * Applies a safe-point preemption to a running task without dropping progress,
 * evidence or follow-up links.
 */
export function markTaskActiveAfterPreemption(
  record: LiteTaskRecord,
  nowIso: string,
): LiteTaskRecord {
  if (record.status !== "running" && record.status !== "active") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "only running/active tasks can be preempted");
  }
  return {
    ...record,
    status: "active",
    revision: record.revision + 1,
    updatedAtIso: nowIso,
  };
}

export function appendProgressCheckpoint(
  record: LiteTaskRecord,
  input: {
    readonly note: string;
    readonly turnId: string;
    readonly atIso: string;
  },
): LiteTaskRecord {
  const note = input.note.trim().slice(0, 2_000);
  if (note === "") return record;
  return {
    ...record,
    revision: record.revision + 1,
    updatedAtIso: input.atIso,
    progressNotes: [
      ...record.progressNotes,
      { atIso: input.atIso, turnId: input.turnId, note },
    ],
  };
}
