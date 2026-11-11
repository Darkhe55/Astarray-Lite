import { LiteError } from "../contracts/errors.js";
import {
  activateNextTask,
  completeActiveTask,
  createEmptyTaskSequence,
  insertTask,
  removeTask,
  reorderTask,
  replaceActiveTask,
  type LiteTaskSequence,
  type TaskInsertPosition,
} from "./task-sequence.js";
import { TaskSequenceStore } from "./task-sequence-store.js";
import {
  applyTaskPatch,
  createTaskRecord,
  type CreateTaskInput,
  type LiteTaskRecord,
  type TaskPatch,
} from "./task-record.js";

export interface TaskStoreOptions {
  readonly sequenceStore?: TaskSequenceStore;
  readonly now?: () => Date;
}

/**
 * In-memory task records plus the authoritative active/pending sequence.
 * Sequence mutations are persisted through `TaskSequenceStore` when supplied.
 */
export class TaskStore {
  private readonly records = new Map<string, LiteTaskRecord>();
  private readonly sequenceStore: TaskSequenceStore | undefined;
  private readonly now: () => Date;
  private sequence: LiteTaskSequence;

  constructor(options: TaskStoreOptions = {}) {
    this.sequenceStore = options.sequenceStore;
    this.now = options.now ?? (() => new Date());
    this.sequence = createEmptyTaskSequence(this.now().toISOString());
  }

  async load(): Promise<void> {
    if (this.sequenceStore === undefined) return;
    this.sequence = await this.sequenceStore.read();
  }

  getSequence(): LiteTaskSequence {
    return this.sequence;
  }

  getTask(taskId: string): LiteTaskRecord | undefined {
    return this.records.get(taskId);
  }

  list(): readonly LiteTaskRecord[] {
    const ids =
      this.sequence.activeTaskId === null
        ? this.sequence.pendingTaskIds
        : [this.sequence.activeTaskId, ...this.sequence.pendingTaskIds];
    return ids
      .map((taskId) => this.records.get(taskId))
      .filter((record): record is LiteTaskRecord => record !== undefined);
  }

  async insertTask(
    input: CreateTaskInput,
    position: TaskInsertPosition = { kind: "bottom" },
  ): Promise<LiteTaskRecord> {
    const record = createTaskRecord({ ...input, nowIso: input.nowIso ?? this.now().toISOString() });
    if (this.records.has(record.taskId)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "task already exists");
    }
    this.records.set(record.taskId, record);
    this.sequence = insertTask(this.sequence, record.taskId, position, this.now().toISOString());
    await this.persist();
    return record;
  }

  async readTop(forceReplace = false): Promise<LiteTaskRecord> {
    const nowIso = this.now().toISOString();
    if (this.sequence.activeTaskId === null) {
      const activated = activateNextTask(this.sequence, nowIso, () => true);
      if (activated.activeTaskId === null) {
        throw new LiteError("LITE_TASK_QUEUE_EMPTY", "task queue is empty");
      }
      this.sequence = activated;
      const active = this.requireRecord(activated.activeTaskId);
      this.records.set(active.taskId, this.withStatus(active, "active", nowIso));
      await this.persist();
      return this.requireRecord(active.taskId);
    }

    if (this.sequence.pendingTaskIds.length === 0) {
      throw new LiteError("LITE_TASK_QUEUE_EMPTY", "task queue is empty");
    }
    if (!forceReplace) {
      throw new LiteError("LITE_ACTIVE_TASK_PRESENT", "an active task already exists", {
        activeTaskId: this.sequence.activeTaskId,
        nextPendingTaskId: this.sequence.pendingTaskIds[0],
      });
    }

    const previousActiveId = this.sequence.activeTaskId;
    const nextTaskId = this.sequence.pendingTaskIds[0];
    if (nextTaskId === undefined) {
      throw new LiteError("LITE_TASK_QUEUE_EMPTY", "task queue is empty");
    }
    this.sequence = replaceActiveTask(this.sequence, nextTaskId, nowIso);
    const previous = this.requireRecord(previousActiveId);
    this.records.set(previous.taskId, this.withStatus(previous, "pending", nowIso));
    const next = this.requireRecord(nextTaskId);
    this.records.set(next.taskId, this.withStatus(next, "active", nowIso));
    await this.persist();
    return this.requireRecord(nextTaskId);
  }

  async updateTask(input: {
    readonly taskId: string;
    readonly patch: TaskPatch;
    readonly expectedRevision: number;
  }): Promise<LiteTaskRecord> {
    const record = this.requireRecord(input.taskId);
    const updated = applyTaskPatch(
      record,
      input.patch,
      input.expectedRevision,
      this.now().toISOString(),
    );
    this.records.set(updated.taskId, updated);
    return updated;
  }

  async reorderTask(taskId: string, toIndex: number): Promise<LiteTaskSequence> {
    this.sequence = reorderTask(this.sequence, taskId, toIndex, this.now().toISOString());
    await this.persist();
    return this.sequence;
  }

  async removeTask(taskId: string): Promise<void> {
    this.sequence = removeTask(this.sequence, taskId, this.now().toISOString());
    this.records.delete(taskId);
    await this.persist();
  }

  async finishActive(input: {
    readonly status: "done" | "stale" | "cancelled";
    readonly archiveReason: string;
    readonly evidence?: LiteTaskRecord["evidence"];
  }): Promise<LiteTaskRecord> {
    if (this.sequence.activeTaskId === null) {
      throw new LiteError("LITE_TASK_NOT_FOUND", "there is no active task");
    }
    const active = this.requireRecord(this.sequence.activeTaskId);
    const nowIso = this.now().toISOString();
    const finished: LiteTaskRecord = {
      ...active,
      status: input.status,
      revision: active.revision + 1,
      updatedAtIso: nowIso,
      evidence: input.evidence ?? active.evidence,
      ...(input.status === "done"
        ? { completedAtIso: nowIso, archivedAtIso: nowIso }
        : { archivedAtIso: nowIso }),
      archiveReason: input.archiveReason,
    };
    this.records.set(active.taskId, finished);
    this.sequence = completeActiveTask(this.sequence, nowIso);
    await this.persist();
    return finished;
  }

  private withStatus(
    record: LiteTaskRecord,
    status: LiteTaskRecord["status"],
    nowIso: string,
  ): LiteTaskRecord {
    return { ...record, status, revision: record.revision + 1, updatedAtIso: nowIso };
  }

  private requireRecord(taskId: string): LiteTaskRecord {
    const record = this.records.get(taskId);
    if (record === undefined) {
      throw new LiteError("LITE_TASK_NOT_FOUND", `task not found: ${taskId}`, { taskId });
    }
    return record;
  }

  private async persist(): Promise<void> {
    if (this.sequenceStore !== undefined) {
      await this.sequenceStore.write(this.sequence);
    }
  }
}
