import type { LiteErrorCode } from "../contracts/errors.js";
import type { CreateTaskInput, LiteTaskRecord } from "./task-record.js";

export type CompletionGapKind =
  | "status"
  | "summary"
  | "criteria"
  | "evidence"
  | "unmet"
  | "pending-tool"
  | "blocked";

export interface CompletionGap {
  readonly kind: CompletionGapKind;
  readonly message: string;
  readonly criterionIndex?: number;
}

export interface CompletionCriterionResult {
  readonly criterionIndex?: number;
  readonly criterion?: string;
  readonly result: "met" | "unmet" | "skipped";
  readonly evidenceRef?: string;
}

export interface CompletionVerificationInput {
  readonly record: LiteTaskRecord;
  readonly summary: string;
  readonly evidence: readonly { readonly reference: string }[];
  readonly criteriaResults: readonly CompletionCriterionResult[];
  readonly selfAssessment: "good" | "needs-review" | "blocked";
  readonly pendingToolCallCount: number;
  readonly followUpTask?: CreateTaskInput | null;
}

export type CompletionVerification =
  | {
      readonly ok: true;
      readonly gaps: readonly [];
      readonly reviewTask?: CreateTaskInput;
    }
  | {
      readonly ok: false;
      readonly code: LiteErrorCode;
      readonly gaps: readonly CompletionGap[];
    };

export function createReviewTask(record: LiteTaskRecord): CreateTaskInput {
  return {
    title: `Review: ${record.title}`,
    objective:
      "Independent review of the completed task: check every acceptance criterion, rerun key commands, inspect artifacts, and report pass/fail with concrete gaps.",
    constraints: [
      "Read-only review; do not modify business files",
      "Rerun key commands instead of relying on memory",
    ],
    acceptanceCriteria: [
      ...record.acceptanceCriteria.map((criterion) => `Verify: ${criterion}`),
      "Report pass/fail and list any gaps",
    ],
    taskKind: "normal",
    source: { kind: "agent", parentTaskId: record.taskId },
    reviewOfTaskId: record.taskId,
  };
}

/**
 * Local completion gate. It never trusts the model's summary alone: criteria
 * must be covered, `met` entries need an existing evidence reference, and the
 * turn must not have pending tool calls or an unresolved block.
 */
export function verifyTaskCompletion(input: CompletionVerificationInput): CompletionVerification {
  const gaps: CompletionGap[] = [];
  if (input.record.status !== "active" && input.record.status !== "running") {
    gaps.push({ kind: "status", message: "task is not active or running" });
  }
  if (input.summary.trim().length < 10) {
    gaps.push({ kind: "summary", message: "summary must be at least 10 characters" });
  }
  if (input.pendingToolCallCount !== 0) {
    gaps.push({ kind: "pending-tool", message: "tool calls are still pending" });
  }
  if (input.record.blockedReason !== undefined || input.selfAssessment === "blocked") {
    gaps.push({ kind: "blocked", message: "task is blocked" });
  }

  const evidenceRefs = new Set(input.evidence.map((entry) => entry.reference));
  input.record.acceptanceCriteria.forEach((criterion, index) => {
    const result = input.criteriaResults.find(
      (candidate) =>
        candidate.criterionIndex === index ||
        (candidate.criterion !== undefined && candidate.criterion === criterion),
    );
    if (result === undefined) {
      gaps.push({
        kind: "criteria",
        message: `acceptance criterion ${index} has no result`,
        criterionIndex: index,
      });
      return;
    }
    if (result.result === "unmet") {
      gaps.push({
        kind: "unmet",
        message: `acceptance criterion ${index} is unmet`,
        criterionIndex: index,
      });
      return;
    }
    if (result.result === "met") {
      if (result.evidenceRef === undefined || result.evidenceRef === "") {
        gaps.push({
          kind: "evidence",
          message: `acceptance criterion ${index} has no evidence reference`,
          criterionIndex: index,
        });
        return;
      }
      if (!evidenceRefs.has(result.evidenceRef)) {
        gaps.push({
          kind: "evidence",
          message: `acceptance criterion ${index} references missing evidence: ${result.evidenceRef}`,
          criterionIndex: index,
        });
      }
    }
  });

  if (gaps.length > 0) {
    return { ok: false, code: "LITE_COMPLETION_INCOMPLETE", gaps };
  }

  const reviewTask =
    input.selfAssessment === "needs-review" && input.followUpTask == null
      ? createReviewTask(input.record)
      : undefined;
  return {
    ok: true,
    gaps: [],
    ...(reviewTask === undefined ? {} : { reviewTask }),
  };
}
