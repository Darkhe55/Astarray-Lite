import { describe, expect, it } from "vitest";

import { createLiteApplication } from "../../src/application/lite-application.js";
import type { LiteEvent } from "../../src/contracts/events.js";

const options = {
  kernel: "lite" as const,
  stateDirectory: ".astarray-lite",
  workspaceRootPath: ".",
  sessionId: "session-1",
  projectIdentifier: "project-1",
};

describe("lite facade envelope", () => {
  it("returns the same result for an idempotency key and emits one event", async () => {
    const app = await createLiteApplication(options);
    const events: LiteEvent[] = [];
    app.subscribe((event) => events.push(event));
    const input = {
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "hello",
      idempotencyKey: "idem-1",
    };

    const first = await app.submitTask(input);
    const second = await app.submitTask(input);
    expect(second).toEqual(first);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task.created",
      revision: 1,
      idempotencyId: "idem-1",
    });
  });

  it("increments revision on cancellation and exposes goal queries", async () => {
    const app = await createLiteApplication(options);
    const events: LiteEvent[] = [];
    app.subscribe((event) => events.push(event));
    await app.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "hello",
    });
    await app.cancelTask({ sessionId: "session-1", taskIdentifier: "task-1" });
    expect(events.map((event) => event.revision)).toEqual([1, 2]);
    expect(events[1]?.type).toBe("task.archived");
    expect(await app.queryGoals()).toEqual([]);
  });

  it("reports the same-session snapshot", async () => {
    const app = await createLiteApplication(options);
    const snapshot = await app.querySnapshot();
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.projectIdentifier).toBe("project-1");
    expect(snapshot.goalCount).toBe(0);
  });
});
