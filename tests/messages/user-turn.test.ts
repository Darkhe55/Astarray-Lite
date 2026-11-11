import { afterEach, describe, expect, it } from "vitest";

import { UserInbox } from "../../src/inbox/user-inbox.js";
import { MessageSlot } from "../../src/messages/message-slot.js";
import { UserTurnController } from "../../src/messages/user-turn.js";
import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(): Promise<{
  readonly inbox: UserInbox;
  readonly controller: UserTurnController;
}> {
  const workspace = await createTestDirectory("user-turn");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  const inbox = new UserInbox({ paths, now: () => new Date(now) });
  return { inbox, controller: new UserTurnController(new MessageSlot(inbox)) };
}

describe("UserTurnController", () => {
  it("admits FIFO and resolves a reply as answered", async () => {
    const { inbox, controller } = await setup();
    const first = await inbox.enqueue({ text: "first" });
    const second = await inbox.enqueue({ text: "second" });

    expect((await controller.admitNext())?.messageId).toBe(first.messageId);
    controller.recordReply("done");
    const resolved = await controller.finalize();
    expect(resolved?.disposition).toBe("answered");
    expect(inbox.getActive()).toBeNull();
    expect(inbox.getQueued().map((message) => message.messageId)).toEqual([second.messageId]);

    expect((await controller.admitNext())?.messageId).toBe(second.messageId);
  });

  it("resolves noise and task creation", async () => {
    const { inbox, controller } = await setup();
    await inbox.enqueue({ text: "noise" });
    await controller.admitNext();
    controller.recordNoise("unrelated greeting");
    expect((await controller.finalize())?.disposition).toBe("noise");

    await inbox.enqueue({ text: "task" });
    await controller.admitNext();
    controller.recordTaskCreation(["task-1", "task-1", "task-2"]);
    const resolved = await controller.finalize();
    expect(resolved?.disposition).toBe("converted-to-task");
    expect(resolved?.createdTaskIds).toEqual(["task-1", "task-2"]);
  });

  it("lets task creation win when a reply is also recorded", async () => {
    const { inbox, controller } = await setup();
    await inbox.enqueue({ text: "do both" });
    await controller.admitNext();
    controller.recordReply("created a task");
    controller.recordTaskCreation(["task-1"]);
    const resolved = await controller.finalize();
    expect(resolved?.disposition).toBe("converted-to-task");
  });

  it("leaves the message admitted when no action is taken", async () => {
    const { inbox, controller } = await setup();
    await inbox.enqueue({ text: "hold" });
    await controller.admitNext();
    const resolved = await controller.finalize();
    expect(resolved?.status).toBe("admitted");
    expect(inbox.getActive()?.status).toBe("admitted");
  });

  it("rejects conflicting actions and actions without an admitted message", async () => {
    const { inbox, controller } = await setup();
    expect(() => controller.recordReply("x")).toThrow(/no user message/u);

    await inbox.enqueue({ text: "conflict" });
    await controller.admitNext();
    controller.recordNoise("a valid reason");
    controller.recordReply("also reply");
    await expect(controller.finalize()).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
  });
});
