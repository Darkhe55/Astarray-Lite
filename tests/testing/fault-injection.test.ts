import { describe, expect, it, vi } from "vitest";

import {
  FaultInjector,
  InjectedFault,
  LITE_FAULT_POINTS,
  withFaultPoint,
} from "../../src/testing/fault-injection.js";

describe("fault injection", () => {
  it("defines at least twelve unique fault points", () => {
    expect(LITE_FAULT_POINTS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(LITE_FAULT_POINTS).size).toBe(LITE_FAULT_POINTS.length);
  });

  it("can throw at every point and remains repeatable", async () => {
    for (const point of LITE_FAULT_POINTS) {
      const injector = new FaultInjector({ [point]: { action: "throw" } });
      await expect(injector.trigger(point)).rejects.toBeInstanceOf(InjectedFault);
      await expect(injector.trigger(point)).rejects.toMatchObject({ point });
      expect(injector.getHitCount(point)).toBe(2);
    }
  });

  it("honors a fixed number of injections", async () => {
    const injector = new FaultInjector({
      "file-write-before-rename": { action: "throw", times: 1 },
    });
    await expect(injector.trigger("file-write-before-rename")).rejects.toBeInstanceOf(InjectedFault);
    await expect(injector.trigger("file-write-before-rename")).resolves.toBe("passed");
  });

  it("runs callbacks and supports repeatable resets", async () => {
    const callback = vi.fn();
    const injector = new FaultInjector({
      "archive-write-before-rename": { action: "callback", callback },
    });
    await expect(injector.trigger("archive-write-before-rename")).resolves.toBe("injected");
    expect(callback).toHaveBeenCalledTimes(1);
    injector.reset();
    await expect(injector.trigger("archive-write-before-rename")).resolves.toBe("passed");
    expect(injector.getHitCount("archive-write-before-rename")).toBe(1);
  });

  it("withFaultPoint stops the operation when injected", async () => {
    const operation = vi.fn(async () => "done");
    const failing = new FaultInjector({ "state-write-before-temp": { action: "throw" } });
    await expect(withFaultPoint(failing, "state-write-before-temp", operation)).rejects.toBeInstanceOf(
      InjectedFault,
    );
    expect(operation).not.toHaveBeenCalled();

    const healthy = new FaultInjector();
    await expect(withFaultPoint(healthy, "state-write-before-temp", operation)).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
