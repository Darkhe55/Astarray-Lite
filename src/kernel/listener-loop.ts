import { LiteError } from "../contracts/errors.js";

const DEFAULT_LISTENER_TICK_MILLISECONDS = 3000;
const MINIMUM_LISTENER_TICK_MILLISECONDS = 100;

export type ListenerWakeReason = "tick" | "wake" | "stopped";

/**
 * Single-waiter heartbeat used by the kernel loop.
 *
 * `waitForWorkOrTick` resolves on an explicit `wake()`, on the configured
 * interval, or on `stop()`. A wake that arrives before the wait is latched, so
 * the loop never loses an input race.
 */
export class ListenerLoop {
  private readonly intervalMilliseconds: number;
  private isRunning = false;
  private hasLatchedWake = false;
  private pendingResolve: ((reason: ListenerWakeReason) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(intervalMilliseconds: number = DEFAULT_LISTENER_TICK_MILLISECONDS) {
    if (
      !Number.isInteger(intervalMilliseconds) ||
      intervalMilliseconds < MINIMUM_LISTENER_TICK_MILLISECONDS
    ) {
      throw new LiteError(
        "LITE_INVALID_ARGUMENT",
        `listener interval must be an integer >= ${MINIMUM_LISTENER_TICK_MILLISECONDS}`,
      );
    }
    this.intervalMilliseconds = intervalMilliseconds;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.hasLatchedWake = false;
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.settle("stopped");
  }

  wake(): void {
    if (!this.isRunning) return;
    if (this.pendingResolve === null) {
      this.hasLatchedWake = true;
      return;
    }
    this.settle("wake");
  }

  async waitForWorkOrTick(): Promise<ListenerWakeReason> {
    if (!this.isRunning) return "stopped";
    if (this.pendingResolve !== null) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "listener already has a pending wait");
    }
    if (this.hasLatchedWake) {
      this.hasLatchedWake = false;
      return "wake";
    }

    return new Promise<ListenerWakeReason>((resolve) => {
      this.pendingResolve = resolve;
      this.timer = setTimeout(() => {
        this.settle("tick");
      }, this.intervalMilliseconds);
    });
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getIntervalMilliseconds(): number {
    return this.intervalMilliseconds;
  }

  private settle(reason: ListenerWakeReason): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    if (resolve !== null) resolve(reason);
  }
}
