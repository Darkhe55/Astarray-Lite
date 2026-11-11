import { describe, expect, it } from "vitest";

import { createLiteApplication } from "../../src/application/lite-application.js";
import type { LiteApplicationFacade } from "../../src/contracts/facade.js";

/**
 * Structural mirror of the GUI application port. Keeping it local avoids
 * importing any UI package while still failing when the facade drifts.
 */
interface GuiApplicationPort {
  subscribe(listener: (event: unknown) => void): { unsubscribe(): void };
  submitTask(input: {
    sessionId: string;
    taskIdentifier: string;
    prompt: string;
    idempotencyKey?: string;
  }): Promise<{ taskIdentifier: string; status: string }>;
  cancelTask(input: { sessionId: string; taskIdentifier: string }): Promise<void>;
  queryCapabilities(): Promise<unknown>;
  querySnapshot(): Promise<unknown>;
  queryGoals(): Promise<unknown>;
}

function acceptsGuiPort(facade: LiteApplicationFacade): GuiApplicationPort {
  return facade;
}

describe("GUI facade compatibility", () => {
  it("satisfies the required GUI port at compile time and runtime", async () => {
    const facade = await createLiteApplication({
      kernel: "lite",
      stateDirectory: ".astarray-lite",
      workspaceRootPath: ".",
    });
    const port = acceptsGuiPort(facade);
    for (const method of [
      "subscribe",
      "submitTask",
      "cancelTask",
      "queryCapabilities",
      "querySnapshot",
      "queryGoals",
    ] as const) {
      expect(typeof port[method]).toBe("function");
    }
  });

  it("keeps the capability snapshot stable", async () => {
    const app = await createLiteApplication({
      kernel: "lite",
      stateDirectory: ".astarray-lite",
      workspaceRootPath: ".",
    });
    expect(await app.queryCapabilities()).toEqual({
      kernel: "lite",
      schemaVersion: 1,
      packageName: "astarray-lite",
      supports: {
        userMessages: true,
        tasks: true,
        goalTasks: true,
        monitors: true,
        toolPackages: true,
        permissions: true,
        history: true,
        multiAgent: false,
        crossProject: false,
        explicitGoalMode: false,
        craftsman: false,
        workWindow: false,
      },
      limitations: [
        "single agent per kernel",
        "single active task and single active user message",
        "no cross-agent delegation",
        "no DAG scheduler or task bundles",
        "no cross-project borrowing in v1",
        "no explicit Goal Mode control plane; goals are task attributes",
      ],
    });
  });

  it("keeps the snapshot and event envelope stable", async () => {
    const app = await createLiteApplication({
      kernel: "lite",
      stateDirectory: ".astarray-lite",
      workspaceRootPath: ".",
      sessionId: "compat-session",
      projectIdentifier: "compat-project",
    });
    const events: Array<{ revision?: number; idempotencyId?: string }> = [];
    app.subscribe((event) => events.push(event));
    await app.submitTask({
      sessionId: "compat-session",
      taskIdentifier: "compat-task",
      prompt: "hello",
      idempotencyKey: "compat-idem",
    });
    expect(events[0]).toMatchObject({ revision: 1, idempotencyId: "compat-idem" });

    const snapshot = (await app.querySnapshot()) as unknown as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual([
      "activeTaskId",
      "activeUserMessageId",
      "goalCount",
      "kernel",
      "pendingTaskCount",
      "projectIdentifier",
      "schemaVersion",
      "sessionId",
      "status",
      "tokenUsage",
      "updatedAtIso",
    ]);
    expect(await app.queryGoals()).toEqual([]);
  });
});
