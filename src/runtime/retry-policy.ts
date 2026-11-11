export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly attempt: number;
  readonly delayMilliseconds: number;
  readonly reason: string;
}

export interface ProviderRetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMilliseconds?: number;
  readonly maximumDelayMilliseconds?: number;
  readonly jitter?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const NON_RETRYABLE_CODES = new Set<string>([
  "LITE_PROVIDER_AUTH_FAILED",
  "LITE_PROVIDER_CONTEXT_OVERFLOW",
  "LITE_INVALID_ARGUMENT",
  "LITE_CONTEXT_BUDGET_EXCEEDED",
]);

const DEFAULT_SLEEP = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * Bounded exponential retry with jitter. Only retryable provider failures are
 * retried; authentication, request-shape and context-overflow errors fail
 * closed immediately.
 */
export class ProviderRetryPolicy {
  private readonly maxAttempts: number;
  private readonly baseDelayMilliseconds: number;
  private readonly maximumDelayMilliseconds: number;
  private readonly jitter: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ProviderRetryPolicyOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMilliseconds = options.baseDelayMilliseconds ?? 1_000;
    this.maximumDelayMilliseconds = options.maximumDelayMilliseconds ?? 8_000;
    this.jitter = options.jitter ?? Math.random;
    this.sleep = options.sleep ?? DEFAULT_SLEEP;

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(this.baseDelayMilliseconds) || this.baseDelayMilliseconds < 0) {
      throw new Error("baseDelayMilliseconds must be non-negative");
    }
    if (!Number.isFinite(this.maximumDelayMilliseconds) || this.maximumDelayMilliseconds < 0) {
      throw new Error("maximumDelayMilliseconds must be non-negative");
    }
  }

  decide(input: {
    readonly attempt: number;
    readonly code: string;
    readonly isRetryable: boolean;
  }): RetryDecision {
    if (!input.isRetryable || NON_RETRYABLE_CODES.has(input.code)) {
      return {
        shouldRetry: false,
        attempt: input.attempt,
        delayMilliseconds: 0,
        reason: "non-retryable provider failure",
      };
    }
    if (input.attempt >= this.maxAttempts) {
      return {
        shouldRetry: false,
        attempt: input.attempt,
        delayMilliseconds: 0,
        reason: "retry attempts exhausted",
      };
    }

    const exponential = this.baseDelayMilliseconds * 2 ** (input.attempt - 1);
    const capped = Math.min(this.maximumDelayMilliseconds, exponential);
    const jittered = Math.round(capped * (0.8 + 0.4 * this.jitter()));
    return {
      shouldRetry: true,
      attempt: input.attempt,
      delayMilliseconds: jittered,
      reason: "retryable provider failure",
    };
  }

  async waitForRetry(decision: RetryDecision): Promise<void> {
    if (!decision.shouldRetry) return;
    await this.sleep(decision.delayMilliseconds);
  }

  getMaxAttempts(): number {
    return this.maxAttempts;
  }
}
