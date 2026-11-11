export const LITE_FAULT_POINTS = [
  "state-write-before-temp",
  "state-write-after-temp",
  "state-write-before-rename",
  "sequence-write-before-rename",
  "journal-append-before-write",
  "journal-append-after-write",
  "backup-before-copy",
  "backup-after-copy",
  "file-write-before-rename",
  "archive-write-before-rename",
  "lock-acquire-before-create",
  "lock-acquire-after-create",
] as const;

export type LiteFaultPoint = (typeof LITE_FAULT_POINTS)[number];

export type FaultAction = "throw" | "callback" | "skip";

export interface FaultRule {
  readonly action: FaultAction;
  readonly times?: number;
  readonly callback?: () => void | Promise<void>;
}

interface MutableRule extends FaultRule {
  remaining: number;
}

export class InjectedFault extends Error {
  readonly point: LiteFaultPoint;

  constructor(point: LiteFaultPoint) {
    super(`injected fault at ${point}`);
    this.name = "InjectedFault";
    this.point = point;
  }
}

/**
 * Deterministic fault injector for crash/recovery tests. Rules can fire
 * repeatedly or a fixed number of times; each trigger is counted.
 */
export class FaultInjector {
  private readonly rules = new Map<LiteFaultPoint, MutableRule>();
  private readonly hits = new Map<LiteFaultPoint, number>();

  constructor(plan: Partial<Record<LiteFaultPoint, FaultRule>> = {}) {
    for (const [point, rule] of Object.entries(plan) as Array<[LiteFaultPoint, FaultRule]>) {
      this.set(point, rule);
    }
  }

  set(point: LiteFaultPoint, rule: FaultRule): void {
    this.rules.set(point, {
      ...rule,
      remaining: rule.times ?? Number.POSITIVE_INFINITY,
    });
  }

  async trigger(point: LiteFaultPoint): Promise<"passed" | "injected" | "skipped"> {
    this.hits.set(point, (this.hits.get(point) ?? 0) + 1);
    const rule = this.rules.get(point);
    if (rule === undefined || rule.remaining <= 0) return "passed";
    rule.remaining -= 1;
    if (rule.action === "callback") {
      if (rule.callback === undefined) {
        throw new InjectedFault(point);
      }
      await rule.callback();
      return "injected";
    }
    if (rule.action === "throw") throw new InjectedFault(point);
    return "skipped";
  }

  getHitCount(point: LiteFaultPoint): number {
    return this.hits.get(point) ?? 0;
  }

  reset(): void {
    this.rules.clear();
    this.hits.clear();
  }
}

export async function withFaultPoint<T>(
  injector: FaultInjector,
  point: LiteFaultPoint,
  operation: () => Promise<T>,
): Promise<T> {
  const outcome = await injector.trigger(point);
  if (outcome === "injected") {
    throw new InjectedFault(point);
  }
  return operation();
}
