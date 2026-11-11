import { LiteError } from "../contracts/errors.js";
import type { LiteKernelStatus } from "../contracts/events.js";

export const KERNEL_TRANSITIONS = {
  booting: ["recovering", "idle", "failed"],
  recovering: ["idle", "blocked", "failed"],
  idle: ["listening", "running", "paused", "stopping"],
  listening: ["running", "idle"],
  running: ["idle", "blocked", "stopping"],
  blocked: ["idle", "running", "paused"],
  paused: ["idle", "stopping"],
  stopping: ["stopped"],
  stopped: [],
  failed: [],
} as const satisfies Record<LiteKernelStatus, readonly LiteKernelStatus[]>;

export function isTerminalKernelStatus(status: LiteKernelStatus): boolean {
  return status === "stopped" || status === "failed";
}

export function canTransitionKernelStatus(
  from: LiteKernelStatus,
  to: LiteKernelStatus,
): boolean {
  return (KERNEL_TRANSITIONS[from] as readonly LiteKernelStatus[]).includes(to);
}

export function assertKernelTransition(
  from: LiteKernelStatus,
  to: LiteKernelStatus,
): void {
  if (!canTransitionKernelStatus(from, to)) {
    throw new LiteError("LITE_INVALID_ARGUMENT", `invalid kernel transition: ${from} -> ${to}`, {
      from,
      to,
    });
  }
}

/**
 * Small, synchronous state machine. It owns transitions only; persistence and
 * side effects belong to the kernel lifecycle around it.
 */
export class KernelStateMachine {
  private status: LiteKernelStatus;

  constructor(initialStatus: LiteKernelStatus = "booting") {
    this.status = initialStatus;
  }

  getStatus(): LiteKernelStatus {
    return this.status;
  }

  canTransitionTo(nextStatus: LiteKernelStatus): boolean {
    return canTransitionKernelStatus(this.status, nextStatus);
  }

  transitionTo(nextStatus: LiteKernelStatus): LiteKernelStatus {
    assertKernelTransition(this.status, nextStatus);
    this.status = nextStatus;
    return this.status;
  }
}
