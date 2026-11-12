import { describe, expect, it, vi } from "vitest";

import { ApprovalBroker } from "../../src/product/approval-broker.js";

const request = {
  toolName: "write_file",
  capability: "fs.write" as const,
  safePreview: "write file",
};

describe("ApprovalBroker", () => {
  it("exposes pending requests and resolves by id", async () => {
    const broker = new ApprovalBroker();
    const listener = vi.fn();
    broker.subscribe(listener);
    const decision = broker.handler(request);
    expect(broker.list()).toHaveLength(1);
    const id = broker.list()[0]?.id ?? "";
    expect(broker.resolve(id, "allow-once")).toBe(true);
    await expect(decision).resolves.toBe("allow-once");
    expect(broker.list()).toHaveLength(0);
    expect(listener).toHaveBeenCalled();
  });

  it("denies after timeout and clears pending requests", async () => {
    const broker = new ApprovalBroker({ timeoutMilliseconds: 10 });
    const decision = broker.handler(request);
    await expect(decision).resolves.toBe("deny");
    expect(broker.list()).toHaveLength(0);

    const pending = broker.handler(request);
    broker.clear();
    await expect(pending).resolves.toBe("deny");
  });
});
