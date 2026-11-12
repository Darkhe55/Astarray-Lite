import { describe, expect, it } from "vitest";

import {
  LITE_CAPABILITIES,
  LITE_ERROR_CODES,
  LITE_PACKAGE_NAME,
  LITE_PACKAGE_VERSION,
  LiteError,
  createLiteApplication,
  describeLiteCapabilities,
  isLiteError,
  isLiteEvent,
} from "../../src/index.js";

describe("lite public contracts", () => {
  it("exposes a stable package identity", () => {
    expect(LITE_PACKAGE_NAME).toBe("astarray-lite");
    expect(LITE_PACKAGE_VERSION).toBe("0.1.0-alpha.1");
  });

  it("keeps error codes unique and non-empty", () => {
    expect(LITE_ERROR_CODES.length).toBeGreaterThan(0);
    expect(new Set(LITE_ERROR_CODES).size).toBe(LITE_ERROR_CODES.length);
    for (const code of LITE_ERROR_CODES) {
      expect(code).toMatch(/^LITE_[A-Z0-9_]+$/);
    }
  });

  it("wraps failures in a typed LiteError", () => {
    const error = new LiteError("LITE_INVALID_ARGUMENT", "bad input", {
      field: "text",
    });
    expect(isLiteError(error)).toBe(true);
    expect(error.code).toBe("LITE_INVALID_ARGUMENT");
    expect(error.message).toBe("bad input");
    expect(error.details).toEqual({ field: "text" });
  });

  it("reports capabilities honestly", () => {
    const descriptor = describeLiteCapabilities();
    expect(descriptor.kernel).toBe("lite");
    expect(descriptor.schemaVersion).toBe(1);
    expect(descriptor.supports.tasks).toBe(true);
    expect(descriptor.supports.goalTasks).toBe(true);
    expect(descriptor.supports.multiAgent).toBe(false);
    expect(descriptor.supports.explicitGoalMode).toBe(false);
    expect(descriptor.limitations.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  });

  it("does not expose a mutable shared capability object", () => {
    const first = describeLiteCapabilities();
    const second = describeLiteCapabilities();
    expect(first).not.toBe(second);
    expect(first.supports).not.toBe(LITE_CAPABILITIES.supports);
  });

  it("recognizes event-shaped values", () => {
    expect(
      isLiteEvent({ type: "kernel.started", atIso: new Date().toISOString() }),
    ).toBe(true);
    expect(isLiteEvent({ type: "kernel.started" })).toBe(false);
    expect(isLiteEvent(null)).toBe(false);
  });

  it("creates a usable facade with queued tasks and snapshots", async () => {
    const application = await createLiteApplication({
      kernel: "lite",
      stateDirectory: ".astarray-lite",
      workspaceRootPath: ".",
    });
    expect(application).toBeDefined();
    const submitted = await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "hello",
    });
    expect(submitted.status).toBe("queued");
    expect((await application.querySnapshot()).kernel).toBe("lite");
  });
});
