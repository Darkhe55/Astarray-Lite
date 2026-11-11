import { describe, expect, it } from "vitest";

import {
  admitUserMessage,
  createUserMessage,
  resolveUserMessage,
  withdrawUserMessage,
} from "../../src/inbox/user-message.js";

const now = "2026-01-01T00:00:00.000Z";

describe("user message lifecycle", () => {
  it("creates a queued message", () => {
    const message = createUserMessage({ text: "hello", nowIso: now });
    expect(message.status).toBe("queued");
    expect(message.revision).toBe(1);
    expect(message.messageId).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(message.attachments).toEqual([]);
  });

  it("rejects empty and oversized messages", () => {
    expect(() => createUserMessage({ text: "   " })).toThrow(/must be non-empty/u);
    expect(() => createUserMessage({ text: "x".repeat(40_000) })).toThrow(/too large/u);
  });

  it("admits and resolves a message", () => {
    const admitted = admitUserMessage(createUserMessage({ text: "hello", nowIso: now }), now);
    expect(admitted.status).toBe("admitted");
    const resolved = resolveUserMessage(admitted, {
      disposition: "answered",
      reason: "replied",
      atIso: now,
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.disposition).toBe("answered");
    expect(resolved.resolutionReason).toBe("replied");
  });

  it("requires admission before resolution and a reason for noise", () => {
    const message = createUserMessage({ text: "hello", nowIso: now });
    expect(() => resolveUserMessage(message, { disposition: "answered", atIso: now })).toThrow();
    const admitted = admitUserMessage(message, now);
    expect(() => resolveUserMessage(admitted, { disposition: "noise", atIso: now })).toThrow();
    expect(() =>
      resolveUserMessage(admitted, { disposition: "noise", reason: "irrelevant", atIso: now }),
    ).not.toThrow();
  });

  it("rejects double resolution and non-queued withdrawal", () => {
    const admitted = admitUserMessage(createUserMessage({ text: "hello", nowIso: now }), now);
    const resolved = resolveUserMessage(admitted, { disposition: "answered", atIso: now });
    expect(() => resolveUserMessage(resolved, { disposition: "answered", atIso: now })).toThrow();
    expect(() => withdrawUserMessage(admitted, now)).toThrow();
  });

  it("withdraws a queued message", () => {
    const message = createUserMessage({ text: "hello", nowIso: now });
    const withdrawn = withdrawUserMessage(message, now);
    expect(withdrawn.status).toBe("resolved");
    expect(withdrawn.resolutionReason).toBe("withdrawn");
  });
});
