import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import { archiveTask, readTaskArchive } from "../../src/tasks/task-archive.js";
import {
  renderTaskMarkdown,
  writeTaskDocuments,
} from "../../src/tasks/task-document.js";
import { createTaskRecord, type LiteTaskRecord } from "../../src/tasks/task-record.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(): Promise<{
  readonly workspace: string;
  readonly paths: ReturnType<typeof resolveLitePaths>;
  readonly record: LiteTaskRecord;
}> {
  const workspace = await createTestDirectory("task-document");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  const record: LiteTaskRecord = {
    ...createTaskRecord({
      title: "Ship report",
      objective: "Produce the quarterly report",
      constraints: ["No external services"],
      acceptanceCriteria: ["Report contains Q3 data", "Commands pass"],
      source: { kind: "user", messageId: "msg_01JABCDEFG" },
      nowIso: now,
      taskId: "tsk_01JABCDEFG",
    }),
    progressNotes: [{ atIso: now, turnId: "trn_01JABCDEFG", note: "drafted outline" }],
    evidence: [{ kind: "file", reference: "report.md", summary: "draft", contentHash: "sha256:abc" }],
  };
  return { workspace, paths, record };
}

describe("task documents", () => {
  it("renders all required sections and provenance", () => {
    const markdown = renderTaskMarkdown(
      {
        ...createTaskRecord({
          title: "Ship report",
          objective: "Produce the report",
          acceptanceCriteria: ["Report exists"],
          source: { kind: "user", messageId: "msg_01JABCDEFG" },
          nowIso: now,
          taskId: "tsk_01JABCDEFG",
        }),
      },
      {
        sourceExcerpt: "please ship the report",
        transcriptPath: "runs/run-1/transcript.jsonl",
        transcriptLineRange: [120, 180],
        decisions: ["use Q3 data"],
        openQuestions: ["who signs off?"],
      },
    );
    for (const heading of [
      "# Ship report",
      "## Goal",
      "## Constraints",
      "## Acceptance criteria",
      "## Context provenance",
      "## Progress",
      "## Evidence",
      "## Open questions",
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("msg_01JABCDEFG");
    expect(markdown).toContain("runs/run-1/transcript.jsonl#L120-L180");
    expect(markdown).toContain("- [ ] Report exists");
  });

  it("writes task.json, task.md and context.md", async () => {
    const { paths, record } = await setup();
    const documentPaths = await writeTaskDocuments({
      paths,
      record,
      options: {
        sourceExcerpt: "please ship the report",
        recalledFiles: [{ path: "data/q3.csv", contentHash: "sha256:def" }],
        decisions: ["use Q3 data"],
      },
    });

    const taskJson = JSON.parse(await fs.readFile(documentPaths.taskJsonPath, "utf8")) as LiteTaskRecord;
    expect(taskJson.taskId).toBe(record.taskId);
    const taskMarkdown = await fs.readFile(documentPaths.taskMarkdownPath, "utf8");
    expect(taskMarkdown).toContain("Produce the quarterly report");
    expect(taskMarkdown).toContain("data/q3.csv");
    expect(taskMarkdown).toContain("drafted outline");
    expect(taskMarkdown).toContain("report.md");
    const contextMarkdown = await fs.readFile(documentPaths.contextMarkdownPath, "utf8");
    expect(contextMarkdown).toContain("please ship the report");
    expect(contextMarkdown).toContain("use Q3 data");
  });
});

describe("task archives", () => {
  it("archives a completed task with status, reason and token usage", async () => {
    const { paths, record } = await setup();
    const done: LiteTaskRecord = {
      ...record,
      status: "done",
      completedAtIso: "2026-01-01T01:00:00.000Z",
    };
    const archive = await archiveTask({
      paths,
      record: done,
      taskMarkdown: renderTaskMarkdown(done),
      archiveReason: "completed",
      archivedAtIso: "2026-01-01T01:00:00.000Z",
      completion: {
        summary: "report shipped",
        evidence: ["report.md"],
        criteriaResults: ["met", "met"],
        selfAssessment: "good",
      },
      tokenUsage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
      reviewChain: ["review-1"],
    });

    expect(archive.record.status).toBe("done");
    expect(archive.durationMilliseconds).toBe(3_600_000);
    expect(archive.tokenUsage.inputTokens).toBe(100);
    expect((await readTaskArchive(paths, record.taskId))?.archiveReason).toBe("completed");
  });

  it("rejects an archive reason that does not match the status", async () => {
    const { paths, record } = await setup();
    await expect(
      archiveTask({
        paths,
        record,
        taskMarkdown: "x",
        archiveReason: "completed",
      }),
    ).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
  });
});
