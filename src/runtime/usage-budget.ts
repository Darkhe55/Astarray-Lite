import { LiteError } from "../contracts/errors.js";
import type { LiteTokenUsage } from "../contracts/events.js";

export interface LiteUsageBudgetPolicy {
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumTotalTokens: number;
  readonly maximumRequests: number;
}

export interface LiteUsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly requests: number;
  readonly totalTokens: number;
}

export const DEFAULT_LITE_USAGE_BUDGET_POLICY: LiteUsageBudgetPolicy = {
  maximumInputTokens: 2_000_000,
  maximumOutputTokens: 500_000,
  maximumTotalTokens: 2_000_000,
  maximumRequests: 10_000,
};

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be a non-negative integer`);
  }
}

/**
 * Tracks provider usage against a session/task budget. It is deliberately
 * accounting-only: callers decide whether to stop before or after a request.
 */
export class LiteUsageBudget {
  private readonly policy: LiteUsageBudgetPolicy;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private requests = 0;

  constructor(policy: LiteUsageBudgetPolicy = DEFAULT_LITE_USAGE_BUDGET_POLICY) {
    for (const [field, value] of Object.entries(policy)) {
      assertNonNegativeInteger(value, field);
    }
    this.policy = policy;
  }

  recordUsage(usage: LiteTokenUsage, requestCount = 1): LiteUsageSnapshot {
    assertNonNegativeInteger(usage.inputTokens, "usage.inputTokens");
    assertNonNegativeInteger(usage.outputTokens, "usage.outputTokens");
    assertNonNegativeInteger(usage.cachedInputTokens, "usage.cachedInputTokens");
    assertNonNegativeInteger(requestCount, "requestCount");

    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cachedInputTokens += usage.cachedInputTokens;
    this.requests += requestCount;
    return this.getSnapshot();
  }

  canMakeRequest(): boolean {
    const snapshot = this.getSnapshot();
    return (
      snapshot.requests < this.policy.maximumRequests &&
      snapshot.inputTokens < this.policy.maximumInputTokens &&
      snapshot.outputTokens < this.policy.maximumOutputTokens &&
      snapshot.totalTokens < this.policy.maximumTotalTokens
    );
  }

  assertCanMakeRequest(): void {
    if (this.canMakeRequest()) return;
    throw new LiteError("LITE_TURN_BUDGET_EXHAUSTED", "usage budget is exhausted", {
      ...this.getSnapshot(),
      policy: this.policy,
    });
  }

  getSnapshot(): LiteUsageSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      requests: this.requests,
      totalTokens: this.inputTokens + this.outputTokens,
    };
  }

  getPolicy(): LiteUsageBudgetPolicy {
    return this.policy;
  }
}
