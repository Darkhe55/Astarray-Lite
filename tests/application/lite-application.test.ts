import { describe, expect, it } from "vitest";

import { createLiteApplication } from "../../src/application/lite-application.js";

const options = {
  kernel: "lite" as const,
  stateDirectory: ".astarray-lite",
  workspaceRootPath: ".",
};

describe("createLiteApplication", () => {
  it("returns a facade with capability and subscription plumbing", async () => {
    const application = await createLiteApplication(options);
    const capabilities = await application.queryCapabilities();
    expect(capabilities.kernel).toBe("lite");
    expect(capabilities.supports.goalTasks).toBe(true);

    const subscription = application.subscribe(() => undefined);
    expect(typeof subscription.unsubscribe).toBe("function");
    subscription.unsubscribe();
  });

  it("rejects an empty user message", async () => {
    const application = await createLiteApplication(options);
    await expect(
      application.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "   ",
      }),
    ).rejects.toMatchObject({ code: "LITE_USER_MESSAGE_EMPTY" });
  });

  it("queues, snapshots and cancels tasks", async () => {
    const application = await createLiteApplication(options);
    const submitted = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "hello",
    });
    expect(submitted.status).toBe("queued");
    const snapshot = await application.querySnapshot();
    expect(snapshot.kernel).toBe("lite");
    expect(snapshot.status).toBe("idle");
    expect(snapshot.pendingTaskCount).toBe(1);

    await application.cancelTask({ sessionId: "session-1", taskIdentifier: "task-1" });
    expect((await application.querySnapshot()).pendingTaskCount).toBe(0);
  });

  it("rejects invalid cancellation input", async () => {
    const application = await createLiteApplication(options);
    await expect(
      application.cancelTask({ sessionId: "", taskIdentifier: "task-1" }),
    ).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
  });
});
