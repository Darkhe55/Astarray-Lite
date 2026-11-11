import { describe, expect, it } from "vitest";

import { ProviderRetryPolicy } from "../../src/runtime/retry-policy.js";

describe("ProviderRetryPolicy", () => {
  it("backs off exponentially with jitter", () => {
    const policy = new ProviderRetryPolicy({
      maxAttempts: 3,
      baseDelayMilliseconds: 1_000,
      maximumDelayMilliseconds: 8_000,
      jitter: () => 0.5,
    });
    expect(policy.decide({ attempt: 1, code: "LITE_PROVIDER_RATE_LIMITED", isRetryable: true })).toEqual({
      shouldRetry: true,
      attempt: 1,
      delayMilliseconds: 1_000,
      reason: "retryable provider failure",
    });
    expect(policy.decide({ attempt: 2, code: "LITE_PROVIDER_RATE_LIMITED", isRetryable: true })).toMatchObject({
      shouldRetry: true,
      delayMilliseconds: 2_000,
    });
    expect(policy.decide({ attempt: 3, code: "LITE_PROVIDER_RATE_LIMITED", isRetryable: true })).toMatchObject({
      shouldRetry: false,
    });
  });

  it("does not retry non-retryable failures", () => {
    const policy = new ProviderRetryPolicy();
    expect(policy.decide({ attempt: 1, code: "LITE_PROVIDER_AUTH_FAILED", isRetryable: true })).toMatchObject({
      shouldRetry: false,
    });
    expect(policy.decide({ attempt: 1, code: "LITE_PROVIDER_REQUEST_FAILED", isRetryable: false })).toMatchObject({
      shouldRetry: false,
    });
  });

  it("waits only when a retry is scheduled", async () => {
    const waits: number[] = [];
    const policy = new ProviderRetryPolicy({
      jitter: () => 0.5,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    await policy.waitForRetry({
      shouldRetry: true,
      attempt: 1,
      delayMilliseconds: 1_000,
      reason: "retryable",
    });
    await policy.waitForRetry({
      shouldRetry: false,
      attempt: 2,
      delayMilliseconds: 0,
      reason: "exhausted",
    });
    expect(waits).toEqual([1_000]);
  });
});
