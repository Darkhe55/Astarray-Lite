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
});
