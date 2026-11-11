import { describe, expect, it } from "vitest";

import {
  createReviewTask,
  verifyTaskCompletion,
  type CompletionVerificationInput,
} from "../../src/tasks/completion-verifier.js";
import { createTaskRecord } from "../../src/tasks/task-record.js";

const now = "2026-01-01T00:00:00.000Z";

function base(overrides: Partial<CompletionVerificationInput> = {}): CompletionVerificationInput {
  const record = {
    ...createTaskRecord({
      title: "ship",
      objective: "ship it",
      acceptanceCriteria: ["report exists", "tests pass"],
      nowIso: now,
      taskId: "tsk_01JABCDEFG",
    }),
    status: "running" as const,
  };
  return {
    record,
    summary: "shipped the report with tests",
    evidence: [{ reference: "report.md" }, { reference: "npm test" }],
    criteriaResults: [
      { criterionIndex: 0, result: "met", evidenceRef: "report.md" },
      { criterionIndex: 1, result: "met", evidenceRef: "npm test" },
    ],
    selfAssessment: "good",
    pendingToolCallCount: 0,
    ...overrides,
  };
}

describe("verifyTaskCompletion", () => {
  it("accepts a fully covered completion", () => {
    expect(verifyTaskCompletion(base())).toEqual({ ok: true, gaps: [] });
  });

  it("rejects missing criteria and unmet results", () => {
    const missing = verifyTaskCompletion(
      base({ criteriaResults: [{ criterionIndex: 0, result: "met", evidenceRef: "report.md" }] }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.gaps).toContainEqual(expect.objectContaining({ kind: "criteria" }));

    const unmet = verifyTaskCompletion(
      base({
        criteriaResults: [
          { criterionIndex: 0, result: "unmet" },
          { criterionIndex: 1, result: "met", evidenceRef: "npm test" },
        ],
      }),
    );
    expect(unmet.ok).toBe(false);
    if (!unmet.ok) expect(unmet.gaps).toContainEqual(expect.objectContaining({ kind: "unmet" }));
  });

  it("requires evidence for met criteria", () => {
    const noRef = verifyTaskCompletion(
      base({
        criteriaResults: [
          { criterionIndex: 0, result: "met" },
          { criterionIndex: 1, result: "met", evidenceRef: "npm test" },
        ],
      }),
    );
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef.gaps).toContainEqual(expect.objectContaining({ kind: "evidence" }));

    const missingRef = verifyTaskCompletion(
      base({
        criteriaResults: [
          { criterionIndex: 0, result: "met", evidenceRef: "missing.md" },
          { criterionIndex: 1, result: "met", evidenceRef: "npm test" },
        ],
      }),
    );
    expect(missingRef.ok).toBe(false);
  });

  it("rejects pending tools, blocked tasks and short summaries", () => {
    expect(verifyTaskCompletion(base({ pendingToolCallCount: 1 })).ok).toBe(false);
    expect(verifyTaskCompletion(base({ selfAssessment: "blocked" })).ok).toBe(false);
    expect(verifyTaskCompletion(base({ summary: "short" })).ok).toBe(false);
  });

  it("rejects inactive tasks", () => {
    const invalid = base();
    const result = verifyTaskCompletion({
      ...invalid,
      record: { ...invalid.record, status: "done" },
    });
    expect(result.ok).toBe(false);
  });

  it("creates a review task for needs-review without a follow-up", () => {
    const result = verifyTaskCompletion(base({ selfAssessment: "needs-review" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reviewTask?.reviewOfTaskId).toBe("tsk_01JABCDEFG");
      expect(result.reviewTask?.constraints).toContain("Read-only review; do not modify business files");
    }
  });

  it("does not auto-create a review task when a follow-up exists", () => {
    const result = verifyTaskCompletion(
      base({
        selfAssessment: "needs-review",
        followUpTask: { title: "fix", objective: "fix the gap" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reviewTask).toBeUndefined();
  });

  it("builds review acceptance criteria from the source task", () => {
    const record = base().record;
    const review = createReviewTask(record);
    expect(review.acceptanceCriteria).toContain("Verify: report exists");
    expect(review.source).toEqual({ kind: "agent", parentTaskId: record.taskId });
  });
});
