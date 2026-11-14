import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProductKernel } from "../../src/product/product-kernel.js";
import { FakeProvider } from "../../src/runtime/fake-provider.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(responses: ConstructorParameters<typeof FakeProvider>[0]) {
  const workspace = await createTestDirectory("product-kernel");
  directories.push(workspace);
  const provider = new FakeProvider(responses);
  const kernel = await createProductKernel({
    workspaceRootPath: workspace,
    sessionId: "session-1",
    projectIdentifier: "project-1",
    provider,
    approvalHandler: async () => "allow-session",
    listenerTickIntervalMilliseconds: 100,
  });
  return { workspace, provider, kernel };
}

describe("createProductKernel", () => {
  it("registers the default coding, shell, reply and task tools", async () => {
    const { kernel } = await setup([]);
    const names = kernel.registry.list().map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "read_file",
        "write_file",
        "replace_in_file",
        "list_directory",
        "shell",
        "reply_user",
        "mark_user_message",
        "task_read_top",
        "task_insert",
        "task_complete",
      ]),
    );
    expect(await kernel.queryGoals()).toEqual([]);
  });

  it("writes a file through the provider tool-call loop", async () => {
    const { workspace, provider, kernel } = await setup([
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "call-1",
            toolName: "write_file",
            argumentsJson: JSON.stringify({ path: "src/result.txt", content: "hello" }),
          },
        ],
      },
      { kind: "text", text: "file written" },
    ]);
    await kernel.start();
    await kernel.submitUserMessage({ text: "write a file" });
    const result = await kernel.runOnce();
    expect(result.outcome).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(await fs.readFile(path.join(workspace, "src", "result.txt"), "utf8")).toBe("hello");
    expect(provider.requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
    expect((await kernel.getSnapshot()).activeUserMessageId).toBeNull();
    await kernel.stop();
  });

  it("runs a queued task when the user inbox is empty", async () => {
    const { kernel } = await setup([
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "call-1",
            toolName: "task_insert",
            argumentsJson: JSON.stringify({
              position: "bottom",
              title: "background task",
              objective: "finish the background work",
              acceptanceCriteria: ["work is finished"],
            }),
          },
        ],
      },
      { kind: "text", text: "task queued" },
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "call-2",
            toolName: "task_complete",
            argumentsJson: JSON.stringify({
              summary: "background work finished",
              selfAssessment: "good",
              evidence: [{ kind: "note", reference: "note-1", summary: "finished" }],
              criteriaResults: [
                { criterionIndex: 0, result: "met", evidenceRef: "note-1" },
              ],
            }),
          },
        ],
      },
      { kind: "text", text: "task turn complete" },
    ]);
    await kernel.start();
    await kernel.submitUserMessage({ text: "create a background task" });
    const first = await kernel.runOnce();
    expect(first.outcome).toBe("completed");
    expect(await kernel.queryTasks()).toHaveLength(1);
    expect((await kernel.runOnce()).outcome).toBe("completed");
    expect(await kernel.queryTasks()).toHaveLength(0);
    await kernel.stop();
  });

  it("preempts a task turn when a user message arrives", async () => {
    const workspace = await createTestDirectory("product-preempt");
    directories.push(workspace);
    let kernelRef: Awaited<ReturnType<typeof createProductKernel>> | undefined;
    let interrupted = false;
    const provider = new FakeProvider(
      [
        {
          kind: "tool-calls",
          calls: [
            {
              callId: "call-1",
              toolName: "task_insert",
              argumentsJson: JSON.stringify({
                position: "bottom",
                title: "background task",
                objective: "finish background work",
                acceptanceCriteria: ["work finished"],
              }),
            },
          ],
        },
        { kind: "text", text: "task queued" },
        {
          kind: "tool-calls",
          calls: [{ callId: "call-2", toolName: "task_list", argumentsJson: "{}" }],
        },
        { kind: "text", text: "user handled" },
        { kind: "text", text: "task resumed" },
      ],
      {
        beforeRespond: async (request) => {
          const isTaskTurn =
            request.messages[0]?.role === "system" &&
            String(request.messages[1]?.content ?? "").includes("后台任务");
          if (isTaskTurn && !interrupted && kernelRef !== undefined) {
            interrupted = true;
            await kernelRef.submitUserMessage({ text: "插入的用户消息" });
          }
        },
      },
    );
    const kernel = await createProductKernel({
      workspaceRootPath: workspace,
      sessionId: "session-preempt",
      projectIdentifier: "project-1",
      provider,
      approvalHandler: async () => "allow-session",
      listenerTickIntervalMilliseconds: 100,
    });
    kernelRef = kernel;
    await kernel.start();
    await kernel.submitUserMessage({ text: "create a background task" });
    expect((await kernel.runOnce()).outcome).toBe("completed");
    expect((await kernel.runOnce()).outcome).toBe("preempted");
    expect(await kernel.queryTasks()).toHaveLength(1);
    expect((await kernel.runOnce()).outcome).toBe("completed");
    await kernel.stop();
  });

  it("rejects a second instance on the same workspace", async () => {
    const { workspace, kernel } = await setup([]);
    await kernel.start();
    const second = await createProductKernel({
      workspaceRootPath: workspace,
      sessionId: "session-2",
      projectIdentifier: "project-1",
      provider: new FakeProvider([]),
      recoverOnStart: false,
    });
    await expect(second.start()).rejects.toMatchObject({ code: "LITE_LOCK_HELD" });
    await kernel.stop();
    await second.start();
    await second.stop();
  });

  it("lists and restores file pre-images", async () => {
    const { workspace, kernel } = await setup([
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "call-1",
            toolName: "write_file",
            argumentsJson: JSON.stringify({ path: "note.txt", content: "v1" }),
          },
        ],
      },
      { kind: "text", text: "first" },
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "call-2",
            toolName: "write_file",
            argumentsJson: JSON.stringify({ path: "note.txt", content: "v2" }),
          },
        ],
      },
      { kind: "text", text: "second" },
    ]);
    await kernel.start();
    await kernel.submitUserMessage({ text: "write v1" });
    await kernel.runOnce();
    await kernel.submitUserMessage({ text: "write v2" });
    await kernel.runOnce();

    const backups = await kernel.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]?.originalPath).toBe("note.txt");
    await kernel.restoreBackup(backups[0]?.backupId ?? "");
    expect(await fs.readFile(path.join(workspace, "note.txt"), "utf8")).toBe("v1");
    expect(await kernel.listBackups()).toHaveLength(2);
    await kernel.stop();
  });

  it("exports a redacted diagnostics bundle", async () => {
    const { workspace, kernel } = await setup([{ kind: "text", text: "ok" }]);
    await kernel.start();
    await kernel.submitUserMessage({ text: "hello" });
    await kernel.runOnce();
    const file = path.join(workspace, "diagnostics.json");
    const bundle = await kernel.exportDiagnostics(file);
    expect(bundle).toMatchObject({ packageName: "astarray-lite", kernelStatus: "idle" });
    const text = await fs.readFile(file, "utf8");
    expect(text).not.toContain(workspace);
    expect(text).not.toContain("authorization");
    await kernel.stop();
  });

  it("recovers from a corrupt state file on start", async () => {
    const { workspace, kernel } = await setup([]);
    const stateRoot = path.join(workspace, ".astarray-lite");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(path.join(stateRoot, "state.json"), "{broken", "utf8");
    await fs.writeFile(
      path.join(stateRoot, "state.json.bak"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        status: "idle",
        updatedAtIso: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    await kernel.start();
    const repaired = await fs.readFile(path.join(stateRoot, "state.json"), "utf8");
    expect(JSON.parse(repaired)).toMatchObject({ schemaVersion: 1, status: "idle" });
    await kernel.stop();
  });
});
