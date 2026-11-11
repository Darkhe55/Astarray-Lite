import { LiteError } from "../contracts/errors.js";
import type { LiteMonitorSpec } from "./monitor-registry.js";

export interface MonitorScheduleState {
  readonly monitorId: string;
  readonly nextDueAtIso: string;
  readonly consecutiveFailures: number;
  readonly isInFlight: boolean;
}

export interface MonitorSchedulerOptions {
  readonly maxConcurrent?: number;
  readonly now?: () => Date;
  readonly jitterMilliseconds?: () => number;
  readonly maximumBackoffSeconds?: number;
  readonly alertDeduplicationMilliseconds?: number;
}

interface MutableState {
  nextDueAtMilliseconds: number;
  consecutiveFailures: number;
  isInFlight: boolean;
}

/**
 * Deterministic scheduler core. Execution is injected: callers ask for due
 * monitors, call beginSample, run the executor, then completeSample.
 */
export class MonitorScheduler {
  private readonly maxConcurrent: number;
  private readonly now: () => Date;
  private readonly jitterMilliseconds: () => number;
  private readonly maximumBackoffSeconds: number;
  private readonly alertDeduplicationMilliseconds: number;
  private readonly states = new Map<string, MutableState>();
  private readonly alertFingerprints = new Map<string, { fingerprint: string; atMilliseconds: number }>();

  constructor(options: MonitorSchedulerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.now = options.now ?? (() => new Date());
    this.jitterMilliseconds = options.jitterMilliseconds ?? (() => 0);
    this.maximumBackoffSeconds = options.maximumBackoffSeconds ?? 600;
    this.alertDeduplicationMilliseconds = options.alertDeduplicationMilliseconds ?? 5 * 60 * 1_000;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "maxConcurrent must be positive");
    }
  }

  sync(definitions: readonly LiteMonitorSpec[]): void {
    const ids = new Set(definitions.map((definition) => definition.monitorId));
    for (const monitorId of [...this.states.keys()]) {
      if (!ids.has(monitorId)) this.states.delete(monitorId);
    }
    const now = this.now().getTime();
    for (const definition of definitions) {
      const existing = this.states.get(definition.monitorId);
      if (existing === undefined) {
        this.states.set(definition.monitorId, {
          nextDueAtMilliseconds: now,
          consecutiveFailures: 0,
          isInFlight: false,
        });
      } else if (!definition.isEnabled && existing.isInFlight) {
        existing.isInFlight = false;
      }
    }
  }

  getDueMonitors(
    definitions: readonly LiteMonitorSpec[],
    nowIso: string = this.now().toISOString(),
  ): readonly LiteMonitorSpec[] {
    const now = Date.parse(nowIso);
    const inFlightCount = [...this.states.values()].filter((state) => state.isInFlight).length;
    const capacity = Math.max(0, this.maxConcurrent - inFlightCount);
    return [...definitions]
      .filter((definition) => {
        if (!definition.isEnabled) return false;
        const state = this.states.get(definition.monitorId);
        return state !== undefined && !state.isInFlight && state.nextDueAtMilliseconds <= now;
      })
      .sort((left, right) => {
        const leftDue = this.states.get(left.monitorId)?.nextDueAtMilliseconds ?? 0;
        const rightDue = this.states.get(right.monitorId)?.nextDueAtMilliseconds ?? 0;
        return leftDue - rightDue || left.name.localeCompare(right.name);
      })
      .slice(0, capacity);
  }

  beginSample(monitorId: string): boolean {
    const state = this.states.get(monitorId);
    if (state === undefined || state.isInFlight) return false;
    if (this.getInFlightCount() >= this.maxConcurrent) return false;
    state.isInFlight = true;
    return true;
  }

  completeSample(
    monitorId: string,
    input: {
      readonly ok: boolean;
      readonly atIso?: string;
      readonly intervalSeconds: number;
    },
  ): MonitorScheduleState {
    const state = this.states.get(monitorId);
    if (state === undefined) {
      throw new LiteError("LITE_MONITOR_NOT_FOUND", "monitor is not scheduled");
    }
    const at = input.atIso === undefined ? this.now().getTime() : Date.parse(input.atIso);
    state.isInFlight = false;
    if (input.ok) {
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures = Math.min(3, state.consecutiveFailures + 1);
    }
    const multiplier = input.ok ? 1 : 2 ** state.consecutiveFailures;
    const intervalMilliseconds = Math.min(
      this.maximumBackoffSeconds,
      input.intervalSeconds * multiplier,
    ) * 1_000;
    state.nextDueAtMilliseconds = at + intervalMilliseconds + Math.max(0, this.jitterMilliseconds());
    return this.snapshot(monitorId);
  }

  /**
   * Returns true when this alert should be emitted. The same fingerprint for
   * the same monitor is suppressed for five minutes.
   */
  markAlert(monitorId: string, fingerprint: string, atIso: string = this.now().toISOString()): boolean {
    const at = Date.parse(atIso);
    const previous = this.alertFingerprints.get(monitorId);
    if (
      previous !== undefined &&
      previous.fingerprint === fingerprint &&
      at - previous.atMilliseconds < this.alertDeduplicationMilliseconds
    ) {
      return false;
    }
    this.alertFingerprints.set(monitorId, { fingerprint, atMilliseconds: at });
    return true;
  }

  getState(monitorId: string): MonitorScheduleState | null {
    return this.states.has(monitorId) ? this.snapshot(monitorId) : null;
  }

  getInFlightCount(): number {
    return [...this.states.values()].filter((state) => state.isInFlight).length;
  }

  private snapshot(monitorId: string): MonitorScheduleState {
    const state = this.states.get(monitorId);
    if (state === undefined) {
      throw new LiteError("LITE_MONITOR_NOT_FOUND", "monitor is not scheduled");
    }
    return {
      monitorId,
      nextDueAtIso: new Date(state.nextDueAtMilliseconds).toISOString(),
      consecutiveFailures: state.consecutiveFailures,
      isInFlight: state.isInFlight,
    };
  }
}
