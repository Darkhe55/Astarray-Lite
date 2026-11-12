import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UserInbox } from "../../src/inbox/user-inbox.js";
import { LiteKernelRuntime } from "../../src/kernel/lite-kernel.js";
import { MessageSlot } from "../../src/messages/message-slot.js";
import { UserTurnController } from "../../src/messages/user-turn.js";
import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import { FakeProvider } from "../../src/runtime/fake-provider.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type { LiteToolSpec } from "../../src/tools/tool-types.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(responses: ConstructorParameters<typeof FakeProvider>[0]) {
  const workspace = await createTestDirectory("lite-kernel");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  const inbox = new UserInbox({ paths, now: () => new Date(now) });
  const slot = new MessageSlot(inbox);
  const userTurn = new UserTurnController(slot);
  const registry = new ToolRegistry();
  const echo: LiteToolSpec = {
    name: "echo",
    summary: "echo",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: true,
    requiresBackup: false,
    inputSchema: { type: "object" },
    handler: async () => ({ outputText: "tool-output" }),
  };
  registry.register(echo);
  const toolExecutor = new ToolExecutor({ registry });
  const provider = new FakeProvider(responses);
  const kernel = new LiteKernelRuntime({
    stateDirectory: ".astarray-lite",
    workspaceRootPath: workspace,
    paths,
    provider,
    registry,
    toolExecutor,
    inbox,
    messageSlot: slot,
    userTurn,
    sessionId: "session-1",
    projectIdentifier: "project-1",
  });
  return { kernel, inbox, slot, provider, workspace };
}

describe("LiteKernelRuntime", () => {
  it("runs a text turn and resolves the user message", async () => {
    const { kernel, inbox, provider } = await setup([{ kind: "text", text: "hello back" }]);
    await kernel.start();
    const receipt = await kernel.submitUserMessage({ text: "hello" });
    expect(receipt.status).toBe("queued");

    const result = await kernel.runOnce();
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("hello back");
    expect(inbox.getActive()).toBeNull();
    expect(inbox.list()[0]?.disposition).toBe("answered");
    expect(provider.requests[0]?.messages[0]?.role).toBe("system");
    expect(provider.requests[0]?.messages[1]?.content).toBe("hello");
    const snapshot = await kernel.getSnapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.activeUserMessageId).toBeNull();
  });

  it("executes a tool batch before replying", async () => {
    const { kernel, provider } = await setup([
      {
        kind: "tool-calls",
        calls: [{ callId: "call-1", toolName: "echo", argumentsJson: "{}" }],
      },
      { kind: "text", text: "tool completed" },
    ]);
    await kernel.start();
    await kernel.submitUserMessage({ text: "use a tool" });
    const result = await kernel.runOnce();
    expect(result.outcome).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    expect(provider.requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("makes no provider request when idle and leaves failed messages admitted", async () => {
    const { kernel, inbox } = await setup([]);
    await kernel.start();
    expect(await kernel.runOnce()).toMatchObject({ outcome: "idle" });
    expect((await kernel.getSnapshot()).status).toBe("idle");

    const failing = await setup([
      {
        kind: "error",
        code: "LITE_PROVIDER_RATE_LIMITED",
        message: "slow down",
        isRetryable: true,
      },
    ]);
    await failing.kernel.start();
    await failing.kernel.submitUserMessage({ text: "retry me" });
    const result = await failing.kernel.runOnce();
    expect(result.outcome).toBe("error");
    expect(inbox.getActive()).toBeNull();
    expect(failing.inbox.getActive()?.status).toBe("admitted");
  });

  it("stops accepting messages after stop", async () => {
    const { kernel } = await setup([]);
    await kernel.start();
    await kernel.stop();
    await expect(kernel.submitUserMessage({ text: "late" })).rejects.toMatchObject({
      code: "LITE_INVALID_ARGUMENT",
    });
  });

  it("passes image attachments to the provider as content parts", async () => {
    const { kernel, provider, workspace } = await setup([{ kind: "text", text: "seen" }]);
    await fs.writeFile(path.join(workspace, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await kernel.start();
    await kernel.submitUserMessage({
      text: "what is this",
      attachments: [{ path: "pixel.png", mediaType: "image/png", sizeBytes: 4 }],
    });
    await kernel.runOnce();
    const parts = provider.requests[0]?.messages[1]?.contentParts;
    expect(parts).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", mediaType: "image/png", dataBase64: "iVBORw==" },
    ]);
    await kernel.stop();
  });
});
