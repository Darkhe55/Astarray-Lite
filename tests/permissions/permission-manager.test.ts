import { describe, expect, it } from "vitest";

import { PermissionAskStore } from "../../src/permissions/ask-store.js";
import { PermissionManager } from "../../src/permissions/permission-manager.js";
import { createSafePreview } from "../../src/permissions/safe-preview.js";

describe("PermissionManager", () => {
  it("applies the profile matrix", () => {
    const safe = new PermissionManager({ profile: "safe" });
    expect(safe.decide({ toolName: "read_file", capability: "fs.read" })).toBe("allow");
    expect(safe.decide({ toolName: "write_file", capability: "fs.write" })).toBe("deny");
    expect(safe.decide({ toolName: "shell", capability: "process.shell" })).toBe("deny");

    const balanced = new PermissionManager({ profile: "balanced" });
    expect(balanced.decide({ toolName: "write_file", capability: "fs.write" })).toBe("ask");
    expect(balanced.decide({ toolName: "shell", capability: "process.shell" })).toBe("ask");

    const trusted = new PermissionManager({ profile: "trusted" });
    expect(trusted.decide({ toolName: "write_file", capability: "fs.write" })).toBe("allow");
  });

  it("applies per-tool and capability overrides", () => {
    const manager = new PermissionManager({
      profile: "safe",
      toolOverrides: { write_file: "enable" },
      capabilityOverrides: { "process.shell": "allow" },
    });
    expect(manager.decide({ toolName: "write_file", capability: "fs.write" })).toBe("allow");
    expect(manager.decide({ toolName: "shell", capability: "process.shell" })).toBe("allow");

    manager.setToolOverride("write_file", "disable");
    expect(manager.decide({ toolName: "write_file", capability: "fs.write" })).toBe("deny");
  });

  it("denies user-only capabilities to the model", () => {
    const manager = new PermissionManager({ profile: "trusted" });
    expect(manager.decide({ toolName: "install_tool", capability: "tool.install" })).toBe("deny");
    expect(
      manager.decide({ toolName: "install_tool", capability: "tool.install", source: "user" }),
    ).toBe("deny");
    manager.setToolOverride("install_tool", "allow");
    expect(
      manager.decide({ toolName: "install_tool", capability: "tool.install", source: "user" }),
    ).toBe("allow");
  });

  it("falls back to deny for unknown tools", () => {
    const manager = new PermissionManager();
    expect(manager.decide({ toolName: "unknown" })).toBe("deny");
  });

  it("caches allow-session grants and expires them", async () => {
    let nowMilliseconds = 1_000;
    const manager = new PermissionManager({
      profile: "balanced",
      now: () => new Date(nowMilliseconds),
      sessionTtlMilliseconds: 1_000,
    });
    const argumentsValue = { path: "a.txt" };
    expect(await manager.authorize({ toolName: "write_file", capability: "fs.write", argumentsValue })).toBe("ask");

    manager.grantSession("fs.write", "write_file", argumentsValue);
    expect(await manager.authorize({ toolName: "write_file", capability: "fs.write", argumentsValue })).toBe("allow");
    expect(
      await manager.authorize({
        toolName: "write_file",
        capability: "fs.write",
        argumentsValue: { path: "b.txt" },
      }),
    ).toBe("ask");

    nowMilliseconds += 1_001;
    expect(await manager.authorize({ toolName: "write_file", capability: "fs.write", argumentsValue })).toBe("ask");
  });

  it("completes an ask with allow-once and allow-session", async () => {
    const manager = new PermissionManager({ profile: "balanced" });
    const args = { path: "a.txt", content: "hello" };
    const pending = manager.requestApproval({
      toolName: "write_file",
      capability: "fs.write",
      argumentsValue: args,
    });
    const asks = manager.listPendingAsks();
    expect(asks).toHaveLength(1);
    manager.resolveAsk(asks[0]?.requestId ?? "", "allow-once");
    await expect(pending).resolves.toBe(true);
    expect(manager.hasSessionGrant("fs.write", "write_file", args)).toBe(false);

    const sessionPending = manager.requestApproval({
      toolName: "write_file",
      capability: "fs.write",
      argumentsValue: args,
    });
    const sessionAsk = manager.listPendingAsks()[0];
    manager.resolveAsk(sessionAsk?.requestId ?? "", "allow-session");
    await expect(sessionPending).resolves.toBe(true);
    expect(manager.hasSessionGrant("fs.write", "write_file", args)).toBe(true);
  });

  it("denies when the ask times out", async () => {
    const manager = new PermissionManager({
      profile: "balanced",
      askStore: new PermissionAskStore({ timeoutMilliseconds: 10 }),
    });
    const result = await manager.requestApproval({
      toolName: "write_file",
      capability: "fs.write",
      argumentsValue: { path: "a.txt" },
    });
    expect(result).toBe(false);
  });

  it("redacts secrets and absolute paths in safe previews", () => {
    const tokenPrefix = ["gh", "p_"].join("");
    const preview = createSafePreview("write_file", {
      path: ["C:", "tmp", "a.txt"].join("\\"),
      text: `${tokenPrefix}${"a".repeat(30)}`,
    });
    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain(tokenPrefix);
    expect(preview).not.toContain("C:\\tmp");
  });
});
