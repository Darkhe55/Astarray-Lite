import { describe, expect, it } from "vitest";

import {
  PreemptionController,
  appendProgressCheckpoint,
  markTaskActiveAfterPreemption,
  RESUME_PROMPT,
} from "../../src/kernel/preemption.js";
import { createTaskRecord, type LiteTaskRecord } from "../../src/tasks/task-record.js";

const now = "2026-01-01T00:00:00.000Z";

function runningTask(): LiteTaskRecord {
  return {
    ...createTaskRecord({
      title: "task",
      objective: "do it",
      nowIso: now,
      taskId: "tsk_01JABCDEFG",
    }),
    status: "running",
    progressNotes: [{ atIso: now, turnId: "trn_1", note: "already done" }],
  };
}

describe("PreemptionController", () => {
  it("preempts only after the current tool batch", () => {
    const controller = new PreemptionController();
    controller.beginTaskTurn("tsk_1");
    expect(controller.afterProviderResponse(true)).toBe("tool-batch");
    expect(controller.requestInterrupt()).toBe(true);
    expect(controller.afterToolBatch()).toBe("preempt");
    controller.endTaskTurn("interrupted");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "idle",
      pendingInterrupt: false,
      consecutiveIncompleteTurns: 1,
    });
  });

  it("preempts before the next provider call when idle at a safe point", () => {
    const controller = new PreemptionController();
    controller.beginTaskTurn("tsk_1");
    controller.requestInterrupt();
    expect(controller.beforeProviderCall()).toBe("preempt");
    controller.endTaskTurn("interrupted");
  });

  it("does nothing without an in-flight turn", () => {
    const controller = new PreemptionController();
    expect(controller.requestInterrupt()).toBe(false);
    expect(controller.beforeProviderCall()).toBe("continue");
  });

  it("blocks after twenty incomplete turns and resets on completion or resume", () => {
    const controller = new PreemptionController({ maximumIncompleteTurns: 20 });
    for (let index = 0; index < 19; index += 1) {
      controller.beginTaskTurn("tsk_1");
      controller.endTaskTurn("interrupted");
    }
    expect(controller.getSnapshot().blocked).toBe(false);
    controller.beginTaskTurn("tsk_1");
    controller.endTaskTurn("interrupted");
    expect(controller.getSnapshot().blocked).toBe(true);
    expect(() => controller.beginTaskTurn("tsk_1")).toThrow(/blocked/u);

    controller.resumeTask();
    controller.beginTaskTurn("tsk_1");
    controller.endTaskTurn("completed");
    expect(controller.getSnapshot()).toMatchObject({
      blocked: false,
      consecutiveIncompleteTurns: 0,
    });
  });

  it("keeps progress notes when the active task is preempted", () => {
    const before = runningTask();
    const after = markTaskActiveAfterPreemption(before, now);
    expect(after.status).toBe("active");
    expect(after.progressNotes).toEqual(before.progressNotes);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.revision).toBe(before.revision + 1);
  });

  it("appends a truncated checkpoint without dropping old notes", () => {
    const before = runningTask();
    const after = appendProgressCheckpoint(before, {
      note: "x".repeat(3_000),
      turnId: "trn_2",
      atIso: now,
    });
    expect(after.progressNotes).toHaveLength(2);
    expect(after.progressNotes[1]?.note).toHaveLength(2_000);
    expect(after.progressNotes[0]?.note).toBe("already done");
    expect(RESUME_PROMPT).toContain("进度");
  });
});
