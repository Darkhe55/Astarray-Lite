import { describe, expect, it } from "vitest";

import {
  KernelStateMachine,
  assertKernelTransition,
  canTransitionKernelStatus,
  isTerminalKernelStatus,
} from "../../src/kernel/state-machine.js";

describe("KernelStateMachine", () => {
  it("walks a valid lifecycle", () => {
    const machine = new KernelStateMachine();
    expect(machine.getStatus()).toBe("booting");
    expect(machine.transitionTo("recovering")).toBe("recovering");
    expect(machine.transitionTo("idle")).toBe("idle");
    expect(machine.transitionTo("running")).toBe("running");
    expect(machine.transitionTo("blocked")).toBe("blocked");
    expect(machine.transitionTo("running")).toBe("running");
    expect(machine.transitionTo("stopping")).toBe("stopping");
    expect(machine.transitionTo("stopped")).toBe("stopped");
    expect(isTerminalKernelStatus(machine.getStatus())).toBe(true);
  });

  it("rejects invalid transitions", () => {
    const machine = new KernelStateMachine("idle");
    expect(() => machine.transitionTo("stopped")).toThrow(/invalid kernel transition/u);
    expect(machine.getStatus()).toBe("idle");
  });

  it("exposes transition predicates", () => {
    expect(canTransitionKernelStatus("idle", "running")).toBe(true);
    expect(canTransitionKernelStatus("running", "paused")).toBe(false);
    expect(() => assertKernelTransition("stopped", "idle")).toThrow();
  });

  it("treats stopped and failed as terminal", () => {
    expect(isTerminalKernelStatus("stopped")).toBe(true);
    expect(isTerminalKernelStatus("failed")).toBe(true);
    expect(isTerminalKernelStatus("blocked")).toBe(false);
  });
});
