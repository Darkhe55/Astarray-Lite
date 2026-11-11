import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UserInbox } from "../../src/inbox/user-inbox.js";
import { MessageSlot } from "../../src/messages/message-slot.js";
import { ReplyStore } from "../../src/messages/reply-store.js";
import { resolveLitePaths, type LitePaths } from "../../src/persistence/lite-paths.js";
import { registerReplyTools } from "../../src/tools/builtin/reply-tools.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(): Promise<{
  readonly workspace: string;
  readonly paths: LitePaths;
  readonly inbox: UserInbox;
  readonly slot: MessageSlot;
  readonly replyStore: ReplyStore;
  readonly executor: ToolExecutor;
}> {
  const workspace = await createTestDirectory("reply-tools");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  const inbox = new UserInbox({ paths, now: () => new Date(now) });
  const slot = new MessageSlot(inbox);
  const replyStore = new ReplyStore({ paths, runId: "run-1", now: () => new Date(now) });
  const registry = new ToolRegistry();
  registerReplyTools(registry, { workspaceRoot: workspace, replyStore, messageSlot: slot });
  return {
    workspace,
    paths,
    inbox,
    slot,
    replyStore,
    executor: new ToolExecutor({ registry }),
  };
}

function call(
  executor: ToolExecutor,
  toolName: string,
  argumentsValue: unknown,
): Promise<import("../../src/tools/tool-types.js").LiteToolExecutionResult> {
  return executor.execute({
    callId: "call-1",
    toolName,
    argumentsJson: JSON.stringify(argumentsValue),
  });
}

describe("reply and mark tools", () => {
  it("sends a reply and resolves the active user message", async () => {
    const { inbox, slot, replyStore, executor, paths } = await setup();
    await inbox.enqueue({ text: "please reply" });
    await slot.admitNext();

    const result = await call(executor, "reply_user", {
      text: "Done.",
      resolvesActiveUserMessage: true,
    });
    expect(result.ok).toBe(true);
    expect(slot.getActive()).toBeNull();
    expect(inbox.list()[0]?.status).toBe("resolved");
    expect(inbox.list()[0]?.disposition).toBe("answered");

    const replies = await replyStore.readReplies();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe("Done.");
    expect(await fs.readdir(path.join(paths.stateRoot, "runs", "run-1"))).toContain(
      "model-notes.jsonl",
    );
  });

  it("keeps the message active for progress replies", async () => {
    const { inbox, slot, replyStore, executor } = await setup();
    await inbox.enqueue({ text: "long task" });
    await slot.admitNext();

    const result = await call(executor, "reply_user", {
      text: "Still working.",
      resolvesActiveUserMessage: false,
    });
    expect(result.ok).toBe(true);
    expect(slot.getActive()).not.toBeNull();
    expect((await replyStore.readReplies())[0]?.resolvesActiveUserMessage).toBe(false);
  });

  it("marks the active message as noise", async () => {
    const { inbox, slot, executor } = await setup();
    await inbox.enqueue({ text: "hello" });
    await slot.admitNext();

    const result = await call(executor, "mark_user_message", {
      disposition: "noise",
      reason: "unrelated greeting",
    });
    expect(result.ok).toBe(true);
    expect(inbox.list()[0]?.disposition).toBe("noise");
    expect(slot.getActive()).toBeNull();
  });

  it("rejects short reasons, missing active messages and missing attachments", async () => {
    const { inbox, slot, executor } = await setup();

    const noActive = await call(executor, "reply_user", {
      text: "hello",
      resolvesActiveUserMessage: true,
    });
    expect(noActive.errorCode).toBe("LITE_USER_MESSAGE_NOT_FOUND");

    await inbox.enqueue({ text: "hello" });
    await slot.admitNext();
    const shortReason = await call(executor, "mark_user_message", {
      disposition: "noise",
      reason: "no",
    });
    expect(shortReason.errorCode).toBe("LITE_TOOL_SCHEMA_INVALID");

    const missingAttachment = await call(executor, "reply_user", {
      text: "see file",
      attachments: ["missing.txt"],
    });
    expect(missingAttachment.errorCode).toBe("LITE_FILE_NOT_FOUND");
  });

  it("validates attachment paths and reports sizes", async () => {
    const { workspace, inbox, slot, executor } = await setup();
    await fs.writeFile(path.join(workspace, "report.md"), "hello", "utf8");
    await inbox.enqueue({ text: "report?" });
    await slot.admitNext();

    const result = await call(executor, "reply_user", {
      text: "Report attached.",
      attachments: ["report.md"],
      resolvesActiveUserMessage: true,
    });
    expect(result.ok).toBe(true);
    expect(result.outputText).toContain("Reply sent");
  });
});
