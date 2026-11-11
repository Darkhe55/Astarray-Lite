import { describe, expect, it } from "vitest";

import { projectGuiHistory } from "../../src/facade/history-projection.js";
import { projectGuiState, projectGuiTasks } from "../../src/facade/gui-projection.js";
import type { LiteKernelSnapshot } from "../../src/contracts/kernel-port.js";
import type { ReplyRecord } from "../../src/messages/reply-store.js";
import { createTaskRecord } from "../../src/tasks/task-record.js";

const now = "2026-01-01T00:00:00.000Z";

function snapshot(): LiteKernelSnapshot {
  return {
    schemaVersion: 1,
    kernel: "lite",
    sessionId: "session-1",
    projectIdentifier: "project-1",
    status: "idle",
    activeUserMessageId: null,
    activeTaskId: null,
    pendingTaskCount: 1,
    goalCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    updatedAtIso: now,
  };
}

describe("GUI projections", () => {
  it("projects compact task rows without task bodies", () => {
    const task = createTaskRecord({
      title: "ship",
      objective: "internal body",
      nowIso: now,
      taskId: "tsk_01JABCDEFG",
    });
    const rows = projectGuiTasks([task]);
    expect(rows).toEqual([
      { taskId: "tsk_01JABCDEFG", title: "ship", status: "pending", taskKind: "normal" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("internal body");

    const state = projectGuiState({ snapshot: snapshot(), tasks: [task], goals: [] });
    expect(state).toMatchObject({ kernel: "lite", status: "idle", sessionId: "session-1" });
  });

  it("projects assistant history with attachment metadata and a limit", () => {
    const replies: ReplyRecord[] = [
      {
        schemaVersion: 1,
        kind: "reply",
        replyId: "msg_1",
        runId: "run-1",
        text: "first",
        attachments: [{ path: "report.md", sizeBytes: 10 }],
        resolvesActiveUserMessage: true,
        createdAtIso: now,
      },
      {
        schemaVersion: 1,
        kind: "reply",
        replyId: "msg_2",
        runId: "run-1",
        text: "second",
        attachments: [],
        resolvesActiveUserMessage: false,
        createdAtIso: now,
      },
    ];
    const history = projectGuiHistory(replies, { limit: 1 });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ messageId: "msg_2", text: "second" });
    expect(projectGuiHistory(replies)[0]?.attachments[0]).toEqual({
      path: "report.md",
      sizeBytes: 10,
    });
  });
});
