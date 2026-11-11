import { LiteError } from "../contracts/errors.js";
import { createLiteIdentifier } from "../contracts/identifiers.js";
import type { LiteTaskKind, LiteTaskRecordStatus } from "./task-sequence.js";

export interface LiteTaskGoal {
  readonly goalState: "pursuing" | "waiting" | "achieved" | "abandoned";
  readonly situation: string;
  readonly successCriteria: readonly string[];
  readonly childTaskIds: readonly string[];
  readonly reviewPolicy: {
    readonly trigger: "after-children" | "interval" | "manual";
    readonly intervalSeconds?: number;
  };
  readonly lastReviewedAtIso?: string;
  readonly nextReviewAtIso?: string;
  readonly reviewRequested: boolean;
  readonly reviewCount: number;
  readonly noProgressReviewCount: number;
  readonly achievedAtIso?: string;
  readonly abandonedAtIso?: string;
}

export interface LiteTaskProgressNote {
  readonly atIso: string;
  readonly turnId: string;
  readonly note: string;
}

export interface LiteTaskEvidence {
  readonly kind: "file" | "command" | "url" | "note";
  readonly reference: string;
  readonly summary: string;
  readonly contentHash?: string;
}

export interface LiteTaskRecord {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly revision: number;
  readonly title: string;
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly status: LiteTaskRecordStatus;
  readonly taskKind: LiteTaskKind;
  readonly parentGoalId?: string;
  readonly goal?: LiteTaskGoal;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly source: {
    readonly kind: "user" | "agent" | "system";
    readonly messageId?: string;
    readonly parentTaskId?: string;
  };
  readonly detailDocumentPath: string;
  readonly progressNotes: readonly LiteTaskProgressNote[];
  readonly evidence: readonly LiteTaskEvidence[];
  readonly blockedReason?: string | undefined;
  readonly attempts: number;
  readonly followUpTaskIds: readonly string[];
  readonly reviewOfTaskId?: string;
  readonly completedAtIso?: string;
  readonly archivedAtIso?: string;
  readonly archiveReason?: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly taskKind?: LiteTaskKind;
  readonly parentGoalId?: string;
  readonly goal?: LiteTaskGoal;
  readonly source?: LiteTaskRecord["source"];
  readonly nowIso?: string;
  readonly taskId?: string;
}

export interface TaskPatch {
  readonly title?: string;
  readonly objective?: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly status?: Extract<LiteTaskRecordStatus, "pending" | "active" | "running" | "blocked">;
  readonly blockedReason?: string | null;
  readonly goal?: LiteTaskGoal;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be non-empty`);
  }
}

export function createTaskRecord(input: CreateTaskInput): LiteTaskRecord {
  assertNonEmpty(input.title, "title");
  assertNonEmpty(input.objective, "objective");
  const taskId = input.taskId ?? createLiteIdentifier("tsk");
  const nowIso = input.nowIso ?? new Date().toISOString();
  const taskKind = input.taskKind ?? "normal";
  if (taskKind === "goal" && input.goal === undefined) {
    throw new LiteError("LITE_GOAL_CRITERIA_REQUIRED", "goal tasks require goal fields");
  }
  return {
    schemaVersion: 1,
    taskId,
    revision: 1,
    title: input.title,
    objective: input.objective,
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    status: "pending",
    taskKind,
    ...(input.parentGoalId === undefined ? {} : { parentGoalId: input.parentGoalId }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
    source: input.source ?? { kind: "agent" },
    detailDocumentPath: `tasks/${taskId}/task.md`,
    progressNotes: [],
    evidence: [],
    attempts: 0,
    followUpTaskIds: [],
  };
}

export function applyTaskPatch(
  record: LiteTaskRecord,
  patch: TaskPatch,
  expectedRevision: number,
  nowIso: string,
): LiteTaskRecord {
  if (expectedRevision !== record.revision) {
    throw new LiteError("LITE_TASK_REVISION_CONFLICT", "task revision conflict", {
      taskId: record.taskId,
      expectedRevision,
      latestRevision: record.revision,
    });
  }
  if (patch.title !== undefined) assertNonEmpty(patch.title, "title");
  if (patch.objective !== undefined) assertNonEmpty(patch.objective, "objective");
  if (patch.status !== undefined && (patch.status === "pending" || patch.status === "active" || patch.status === "running" || patch.status === "blocked")) {
    // Allowed non-terminal statuses only.
  }
  return {
    ...record,
    revision: record.revision + 1,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.objective === undefined ? {} : { objective: patch.objective }),
    ...(patch.constraints === undefined ? {} : { constraints: patch.constraints }),
    ...(patch.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: patch.acceptanceCriteria }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.blockedReason === undefined
      ? {}
      : patch.blockedReason === null
        ? { blockedReason: undefined }
        : { blockedReason: patch.blockedReason }),
    ...(patch.goal === undefined ? {} : { goal: patch.goal }),
    updatedAtIso: nowIso,
  };
}
