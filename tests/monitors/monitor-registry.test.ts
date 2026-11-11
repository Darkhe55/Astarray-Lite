import { afterEach, describe, expect, it } from "vitest";

import {
  MAXIMUM_ENABLED_MONITORS,
  MAXIMUM_MONITOR_DEFINITIONS,
  MonitorRegistry,
  type CreateMonitorInput,
} from "../../src/monitors/monitor-registry.js";
import { resolveLitePaths, type LitePaths } from "../../src/persistence/lite-paths.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(): Promise<{ readonly paths: LitePaths; readonly registry: MonitorRegistry }> {
  const workspace = await createTestDirectory("monitor-registry");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  return { paths, registry: new MonitorRegistry({ paths, now: () => new Date(now) }) };
}

function commandInput(name: string, overrides: Partial<CreateMonitorInput> = {}): CreateMonitorInput {
  return {
    name,
    kind: "command",
    config: {
      kind: "command",
      command: "npm test",
      workingDirectory: ".",
      environmentVariableNames: ["CI"],
    },
    nowIso: now,
    ...overrides,
  };
}

describe("MonitorRegistry", () => {
  it("persists definitions and advances revision", async () => {
    const { paths, registry } = await setup();
    const created = await registry.create(commandInput("tests"));
    expect(created.monitorId).toMatch(/^mon_/u);
    expect(registry.getRevision()).toBe(2);

    const reloaded = new MonitorRegistry({ paths, now: () => new Date(now) });
    await reloaded.load();
    expect(reloaded.list().map((monitor) => monitor.name)).toEqual(["tests"]);
    expect(reloaded.getRevision()).toBe(2);
  });

  it("enforces unique names", async () => {
    const { registry } = await setup();
    await registry.create(commandInput("tests"));
    await expect(registry.create(commandInput("tests"))).rejects.toMatchObject({
      code: "LITE_INVALID_ARGUMENT",
    });
  });

  it("enforces the definition and enabled limits", async () => {
    const { registry } = await setup();
    for (let index = 0; index < MAXIMUM_MONITOR_DEFINITIONS; index += 1) {
      await registry.create(commandInput(`m-${index}`));
    }
    await expect(registry.create(commandInput("one-too-many"))).rejects.toMatchObject({
      code: "LITE_MONITOR_LIMIT_EXCEEDED",
    });

    const { registry: enabledRegistry } = await setup();
    for (let index = 0; index < MAXIMUM_ENABLED_MONITORS; index += 1) {
      await enabledRegistry.create(commandInput(`e-${index}`, { isEnabled: true }));
    }
    await expect(
      enabledRegistry.create(commandInput("enabled-too-many", { isEnabled: true })),
    ).rejects.toMatchObject({ code: "LITE_MONITOR_LIMIT_EXCEEDED" });
  });

  it("rejects invalid interval, kind/config and config values", async () => {
    const { registry } = await setup();
    await expect(
      registry.create(commandInput("bad-interval", { intervalSeconds: 2 })),
    ).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
    await expect(
      registry.create(commandInput("bad-timeout", { timeoutSeconds: 0 })),
    ).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
    await expect(
      registry.create({
        name: "mismatch",
        kind: "file",
        config: { kind: "command", command: "x", workingDirectory: ".", environmentVariableNames: [] },
        nowIso: now,
      }),
    ).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
    await expect(
      registry.create({
        name: "bad-http",
        kind: "http",
        config: { kind: "http", url: "ftp://example.com", method: "GET" },
        nowIso: now,
      }),
    ).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
  });

  it("updates with revision checks and toggles enabled state", async () => {
    const { registry } = await setup();
    const monitor = await registry.create(commandInput("tests"));
    const updated = await registry.update(monitor.monitorId, {
      intervalSeconds: 30,
      expectedRevision: monitor.revision,
    });
    expect(updated.intervalSeconds).toBe(30);
    await expect(
      registry.update(monitor.monitorId, { intervalSeconds: 10, expectedRevision: monitor.revision }),
    ).rejects.toMatchObject({ code: "LITE_TASK_REVISION_CONFLICT" });

    const enabled = await registry.setEnabled(monitor.monitorId, true);
    expect(enabled.isEnabled).toBe(true);
    expect(await registry.setEnabled(monitor.monitorId, false)).toMatchObject({ isEnabled: false });
  });
});
