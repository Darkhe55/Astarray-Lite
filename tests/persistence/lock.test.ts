import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LiteLock } from "../../src/persistence/lock.js";
import { createTestDirectory, removeTestDirectory } from "./test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function lockFile(): Promise<string> {
  const directory = await createTestDirectory("lock");
  directories.push(directory);
  return path.join(directory, "kernel.lock");
}

describe("LiteLock", () => {
  it("acquires, blocks a second writer, and releases", async () => {
    const file = await lockFile();
    const first = new LiteLock({ lockFile: file });
    const second = new LiteLock({ lockFile: file });

    const firstResult = await first.acquire();
    expect(firstResult.acquired).toBe(true);

    const blocked = await second.acquire();
    expect(blocked.acquired).toBe(false);
    if (!blocked.acquired) {
      expect(blocked.holder?.token).toBe(firstResult.acquired ? firstResult.record.token : "");
    }

    await expect(first.release()).resolves.toBe(true);
    const afterRelease = await second.acquire();
    expect(afterRelease.acquired).toBe(true);
    await second.release();
  });

  it("takes over a stale lock explicitly", async () => {
    const file = await lockFile();
    let nowMilliseconds = Date.parse("2026-01-01T00:00:00.000Z");
    const now = (): Date => new Date(nowMilliseconds);

    const first = new LiteLock({
      lockFile: file,
      now,
      staleAfterMilliseconds: 30_000,
    });
    const second = new LiteLock({
      lockFile: file,
      now,
      staleAfterMilliseconds: 30_000,
    });

    await first.acquire();
    nowMilliseconds += 31_000;
    const takeover = await second.acquire();
    expect(takeover.acquired).toBe(true);
    if (takeover.acquired) {
      expect(takeover.wasStaleTakeover).toBe(true);
    }
    await second.release();
  });

  it("refreshes the heartbeat only for the owner", async () => {
    const file = await lockFile();
    let nowMilliseconds = Date.parse("2026-01-01T00:00:00.000Z");
    const now = (): Date => new Date(nowMilliseconds);
    const lock = new LiteLock({ lockFile: file, now });

    const acquired = await lock.acquire();
    expect(acquired.acquired).toBe(true);
    nowMilliseconds += 5_000;
    await expect(lock.heartbeat()).resolves.toBe(true);
    const holder = await lock.readHolder();
    expect(holder?.heartbeatAtIso).toBe("2026-01-01T00:00:05.000Z");
    await lock.release();
  });

  it("does not release a lock owned by another token", async () => {
    const file = await lockFile();
    const owner = new LiteLock({ lockFile: file });
    const stranger = new LiteLock({ lockFile: file });
    await owner.acquire();
    await expect(stranger.release()).resolves.toBe(false);
    await owner.release();
  });
});
