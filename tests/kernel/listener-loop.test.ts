import { afterEach, describe, expect, it, vi } from "vitest";

import { ListenerLoop } from "../../src/kernel/listener-loop.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ListenerLoop", () => {
  it("resolves on the configured interval", async () => {
    vi.useFakeTimers();
    const loop = new ListenerLoop(3000);
    loop.start();
    const waiting = loop.waitForWorkOrTick();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(waiting).resolves.toBe("tick");
  });

  it("resolves immediately on wake", async () => {
    vi.useFakeTimers();
    const loop = new ListenerLoop(3000);
    loop.start();
    const waiting = loop.waitForWorkOrTick();
    loop.wake();
    await expect(waiting).resolves.toBe("wake");
  });

  it("latches a wake that arrives before the wait", async () => {
    const loop = new ListenerLoop(3000);
    loop.start();
    loop.wake();
    await expect(loop.waitForWorkOrTick()).resolves.toBe("wake");
  });

  it("resolves stopped waiters", async () => {
    const loop = new ListenerLoop(3000);
    loop.start();
    const waiting = loop.waitForWorkOrTick();
    loop.stop();
    await expect(waiting).resolves.toBe("stopped");
    await expect(loop.waitForWorkOrTick()).resolves.toBe("stopped");
  });

  it("rejects overlapping waits", async () => {
    vi.useFakeTimers();
    const loop = new ListenerLoop(3000);
    loop.start();
    const first = loop.waitForWorkOrTick();
    await expect(loop.waitForWorkOrTick()).rejects.toMatchObject({
      code: "LITE_INVALID_ARGUMENT",
    });
    loop.stop();
    await expect(first).resolves.toBe("stopped");
  });

  it("rejects an interval below the minimum", () => {
    expect(() => new ListenerLoop(99)).toThrow(/listener interval/u);
  });
});
