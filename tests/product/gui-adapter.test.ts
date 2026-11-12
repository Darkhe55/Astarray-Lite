import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalBroker } from "../../src/product/approval-broker.js";
import { ProductGuiAdapter } from "../../src/product/gui-adapter.js";
import { createProductKernel } from "../../src/product/product-kernel.js";
import { FakeProvider } from "../../src/runtime/fake-provider.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(responses: ConstructorParameters<typeof FakeProvider>[0], approvals?: ApprovalBroker) {
  const workspace = await createTestDirectory("gui-adapter");
  directories.push(workspace);
  const kernel = await createProductKernel({
    workspaceRootPath: workspace,
    sessionId: "gui",
    projectIdentifier: "gui",
    provider: new FakeProvider(responses),
    ...(approvals === undefined ? {} : { approvalHandler: approvals.handler }),
  });
  const adapter = new ProductGuiAdapter({
    kernel,
    ...(approvals === undefined ? {} : { approvals }),
  });
  return { workspace, kernel, adapter, approvals };
}

describe("ProductGuiAdapter", () => {
  it("maps task submission, snapshots, goals and capabilities", async () => {
    const { kernel, adapter } = await setup([{ kind: "text", text: "done" }]);
    await kernel.start();
    const submitted = await adapter.submitTask({
      sessionId: "gui",
      taskIdentifier: "task-1",
      prompt: "hello",
    });
    expect(submitted).toEqual({ taskIdentifier: "task-1", status: "queued" });
    expect(await adapter.submitTask({ sessionId: "gui", taskIdentifier: "task-1", prompt: "again" })).toEqual({
      taskIdentifier: "task-1",
      status: "queued",
    });
    await kernel.runOnce();
    expect((await adapter.querySnapshot()).activeUserMessageId).toBeNull();
    const history = await adapter.queryHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.text).toBe("done");
    expect(await adapter.queryTasks()).toEqual([]);
    expect(await adapter.queryGoals()).toEqual([]);
    expect(await adapter.queryCapabilities()).toMatchObject({
      images: false,
      documents: true,
      approvals: false,
    });
    await kernel.stop();
  });

  it("cancels a queued task by task identifier", async () => {
    const { kernel, adapter } = await setup([]);
    await kernel.start();
    await adapter.submitTask({ sessionId: "gui", taskIdentifier: "task-1", prompt: "hello" });
    expect(await adapter.cancelTask({ sessionId: "gui", taskIdentifier: "task-1" })).toBe(true);
    expect(await kernel.runOnce()).toMatchObject({ outcome: "idle" });
    await kernel.stop();
  });

  it("exposes and resolves pending approvals", async () => {
    const approvals = new ApprovalBroker({ timeoutMilliseconds: 0 });
    const { workspace, kernel, adapter } = await setup(
      [
        {
          kind: "tool-calls",
          calls: [
            {
              callId: "c1",
              toolName: "write_file",
              argumentsJson: JSON.stringify({ path: "approved.txt", content: "yes" }),
            },
          ],
        },
        { kind: "text", text: "written" },
      ],
      approvals,
    );
    await kernel.start();
    await adapter.submitTask({ sessionId: "gui", taskIdentifier: "task-1", prompt: "write" });
    const running = kernel.runOnce();
    while (adapter.queryApprovals().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const pending = adapter.queryApprovals()[0];
    expect(pending?.request.toolName).toBe("write_file");
    expect(adapter.resolveApproval(pending?.id ?? "", "allow-once")).toBe(true);
    const result = await running;
    expect(result.outcome).toBe("completed");
    expect(await fs.readFile(path.join(workspace, "approved.txt"), "utf8")).toBe("yes");
    await kernel.stop();
  });
});
