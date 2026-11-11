import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { UserInbox } from "../../src/inbox/user-inbox.js";
import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function inbox(): Promise<{ readonly inbox: UserInbox; readonly workspace: string; readonly paths: ReturnType<typeof resolveLitePaths> }> {
  const workspace = await createTestDirectory("inbox");
  directories.push(workspace);
  const paths = resolveLitePaths({
    stateDirectory: ".astarray-lite",
    workspaceRootPath: workspace,
  });
  return {
    inbox: new UserInbox({ paths, now: () => new Date(now) }),
    workspace,
    paths,
  };
}

describe("UserInbox", () => {
  it("enqueues, admits FIFO, and resolves", async () => {
    const { inbox: userInbox } = await inbox();
    const first = await userInbox.enqueue({ text: "first", nowIso: now });
    const second = await userInbox.enqueue({ text: "second", nowIso: now });

    expect(userInbox.getQueued().map((message) => message.messageId)).toEqual([
      first.messageId,
      second.messageId,
    ]);

    const admitted = await userInbox.admitNext();
    expect(admitted?.messageId).toBe(first.messageId);
    expect(admitted?.status).toBe("admitted");
    expect(userInbox.getActive()?.messageId).toBe(first.messageId);

    const resolved = await userInbox.resolve({
      messageId: first.messageId,
      disposition: "answered",
      reason: "replied",
    });
    expect(resolved.status).toBe("resolved");
    expect(userInbox.getActive()).toBeNull();
  });

  it("replays the journal on reload", async () => {
    const { inbox: userInbox, workspace, paths } = await inbox();
    const first = await userInbox.enqueue({ text: "first", nowIso: now });
    await userInbox.admitNext();
    await userInbox.resolve({
      messageId: first.messageId,
      disposition: "converted-to-task",
      createdTaskIds: ["task-1"],
    });

    const reloadedPaths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
    const reloaded = new UserInbox({ paths: reloadedPaths, now: () => new Date(now) });
    await reloaded.load();
    const message = reloaded.list()[0];
    expect(message?.status).toBe("resolved");
    expect(message?.disposition).toBe("converted-to-task");
    expect(message?.createdTaskIds).toEqual(["task-1"]);
  });

  it("is idempotent by key", async () => {
    const { inbox: userInbox } = await inbox();
    const first = await userInbox.enqueue({ text: "hello", idempotencyKey: "key-1" });
    const second = await userInbox.enqueue({ text: "hello again", idempotencyKey: "key-1" });
    expect(second.messageId).toBe(first.messageId);
    expect(userInbox.list()).toHaveLength(1);
  });

  it("withdraws only queued messages", async () => {
    const { inbox: userInbox } = await inbox();
    const first = await userInbox.enqueue({ text: "first" });
    await userInbox.admitNext();
    await expect(userInbox.withdraw(first.messageId)).resolves.toBe(false);
  });

  it("rebuilds a corrupt index from the journal", async () => {
    const { inbox: userInbox, workspace, paths } = await inbox();
    await userInbox.enqueue({ text: "first" });
    const indexPath = paths.inboxIndexFile;
    await writeFile(indexPath, "{broken", "utf8");

    const reloadedPaths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
    const reloaded = new UserInbox({ paths: reloadedPaths, now: () => new Date(now) });
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(1);
  });
});

