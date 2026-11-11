import { describe, expect, it } from "vitest";

import { LiteUsageBudget } from "../../src/runtime/usage-budget.js";

describe("LiteUsageBudget", () => {
  it("accumulates usage and requests", () => {
    const budget = new LiteUsageBudget();
    budget.recordUsage({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
    budget.recordUsage({ inputTokens: 3, outputTokens: 4, cachedInputTokens: 1 }, 2);
    expect(budget.getSnapshot()).toEqual({
      inputTokens: 13,
      outputTokens: 9,
      cachedInputTokens: 3,
      requests: 3,
      totalTokens: 22,
    });
    expect(budget.canMakeRequest()).toBe(true);
  });

  it("stops at the request limit", () => {
    const budget = new LiteUsageBudget({
      maximumInputTokens: 1_000,
      maximumOutputTokens: 1_000,
      maximumTotalTokens: 2_000,
      maximumRequests: 2,
    });
    budget.recordUsage({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
    budget.recordUsage({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
    expect(budget.canMakeRequest()).toBe(false);
    expect(() => budget.assertCanMakeRequest()).toThrow(/budget is exhausted/u);
  });

  it("stops at the total token limit", () => {
    const budget = new LiteUsageBudget({
      maximumInputTokens: 1_000,
      maximumOutputTokens: 1_000,
      maximumTotalTokens: 10,
      maximumRequests: 100,
    });
    budget.recordUsage({ inputTokens: 6, outputTokens: 5, cachedInputTokens: 0 });
    expect(budget.canMakeRequest()).toBe(false);
  });

  it("rejects negative usage", () => {
    const budget = new LiteUsageBudget();
    expect(() =>
      budget.recordUsage({ inputTokens: -1, outputTokens: 0, cachedInputTokens: 0 }),
    ).toThrow();
  });
});
