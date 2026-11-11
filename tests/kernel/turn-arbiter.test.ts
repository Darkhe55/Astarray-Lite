import { describe, expect, it } from "vitest";

import { TaskLoop } from "../../src/kernel/task-loop.js";
import { TurnArbiter } from "../../src/kernel/turn-arbiter.js";

function input(overrides: {
  readonly hasActiveUserMessage?: boolean;
  readonly hasRunnableTask?: boolean;
  readonly isPaused?: boolean;
  readonly isStopping?: boolean;
} = {}) {
  return {
    hasActiveUserMessage: overrides.hasActiveUserMessage ?? false,
    hasRunnableTask: overrides.hasRunnableTask ?? false,
    isPaused: overrides.isPaused ?? false,
    isStopping: overrides.isStopping ?? false,
  };
}

describe("TurnArbiter", () => {
  it("prioritizes user messages over tasks", () => {
    const arbiter = new TurnArbiter();
    expect(arbiter.decide(input({ hasActiveUserMessage: true, hasRunnableTask: true }))).toEqual({
      kind: "user",
    });
  });

  it("runs a task when there is no user message", () => {
    const arbiter = new TurnArbiter();
    expect(arbiter.decide(input({ hasRunnableTask: true }))).toEqual({ kind: "task" });
  });

  it("stays idle without work or while paused/stopping", () => {
    const arbiter = new TurnArbiter();
    expect(arbiter.decide(input())).toEqual({ kind: "idle", reason: "no-work" });
    expect(arbiter.decide(input({ isPaused: true, hasRunnableTask: true }))).toEqual({
      kind: "idle",
      reason: "paused",
    });
    expect(arbiter.decide(input({ isStopping: true, hasActiveUserMessage: true }))).toEqual({
      kind: "idle",
      reason: "stopping",
    });
  });

  it("enforces a single in-flight turn", () => {
    const arbiter = new TurnArbiter();
    expect(arbiter.beginTurn()).toBe(true);
    expect(arbiter.hasTurnInFlight()).toBe(true);
    expect(arbiter.decide(input({ hasRunnableTask: true }))).toEqual({
      kind: "idle",
      reason: "turn-in-flight",
    });
    expect(arbiter.beginTurn()).toBe(false);
    arbiter.endTurn();
    expect(arbiter.hasTurnInFlight()).toBe(false);
  });
});

describe("TaskLoop", () => {
  it("runs exactly one turn and releases the guard", async () => {
    const loop = new TaskLoop();
    const calls: string[] = [];
    const decision = await loop.runOnce({
      ...input({ hasActiveUserMessage: true, hasRunnableTask: true }),
      runUserTurn: async () => {
        calls.push("user");
      },
      runTaskTurn: async () => {
        calls.push("task");
      },
    });

    expect(decision.kind).toBe("user");
    expect(calls).toEqual(["user"]);
    expect(loop.getArbiter().hasTurnInFlight()).toBe(false);
  });

  it("does not run callbacks when idle", async () => {
    const loop = new TaskLoop();
    const calls: string[] = [];
    const decision = await loop.runOnce({
      ...input(),
      runUserTurn: async () => {
        calls.push("user");
      },
      runTaskTurn: async () => {
        calls.push("task");
      },
    });

    expect(decision).toEqual({ kind: "idle", reason: "no-work" });
    expect(calls).toEqual([]);
  });

  it("releases the guard when a turn throws", async () => {
    const loop = new TaskLoop();
    await expect(
      loop.runOnce({
        ...input({ hasRunnableTask: true }),
        runUserTurn: async () => undefined,
        runTaskTurn: async () => {
          throw new Error("turn failed");
        },
      }),
    ).rejects.toThrow("turn failed");
    expect(loop.getArbiter().hasTurnInFlight()).toBe(false);
  });
});
