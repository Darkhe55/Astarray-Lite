import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executeMonitor,
  isPrivateHttpTarget,
  type MonitorExecutorDependencies,
  type ProcessProbe,
  type SystemMetricsProvider,
} from "../../src/monitors/monitor-executors.js";
import { createMonitorSpec, type CreateMonitorInput } from "../../src/monitors/monitor-registry.js";
import type { ShellProcessRunner, ShellRunRequest, ShellRunResult } from "../../src/tools/builtin/shell-tool.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];
const now = "2026-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

class FakeShellRunner implements ShellProcessRunner {
  readonly requests: ShellRunRequest[] = [];
  constructor(private readonly result: ShellRunResult) {}
  async run(request: ShellRunRequest): Promise<ShellRunResult> {
    this.requests.push(request);
    return this.result;
  }
}

function spec(input: CreateMonitorInput) {
  return createMonitorSpec({
    ...input,
    nowIso: now,
    monitorId: "mon_01JABCDEFG",
    intervalSeconds: 60,
    timeoutSeconds: 10,
  });
}

const okShell: ShellRunResult = { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, wasAborted: false };

describe("monitor executors", () => {
  it("executes command monitors through the injected runner", async () => {
    const workspace = await createTestDirectory("monitor-command");
    directories.push(workspace);
    const runner = new FakeShellRunner(okShell);
    const result = await executeMonitor(
      spec({
        name: "tests",
        kind: "command",
        config: { kind: "command", command: "npm test", workingDirectory: ".", environmentVariableNames: [] },
      }),
      { workspaceRoot: workspace, shellRunner: runner, now: () => new Date(now) },
    );
    expect(result.ok).toBe(true);
    expect(result.value).toContain("ok");
    expect(runner.requests[0]?.command).toBe("npm test");
    expect(runner.requests[0]?.cwd).toBe(workspace);
  });

  it("samples file mtime, size, content hash and regex", async () => {
    const workspace = await createTestDirectory("monitor-file");
    directories.push(workspace);
    await fs.writeFile(path.join(workspace, "a.txt"), "hello world", "utf8");
    const dependencies: MonitorExecutorDependencies = { workspaceRoot: workspace, now: () => new Date(now) };

    const mtime = await executeMonitor(
      spec({ name: "mtime", kind: "file", config: { kind: "file", relativePath: "a.txt", watch: "mtime" } }),
      dependencies,
    );
    expect(mtime.ok).toBe(true);
    expect(mtime.numericValue).toBeGreaterThan(0);

    const size = await executeMonitor(
      spec({ name: "size", kind: "file", config: { kind: "file", relativePath: "a.txt", watch: "size" } }),
      dependencies,
    );
    expect(size.value).toBe("11");

    const hash = await executeMonitor(
      spec({ name: "hash", kind: "file", config: { kind: "file", relativePath: "a.txt", watch: "content-hash" } }),
      dependencies,
    );
    expect(hash.value).toMatch(/^sha256:/u);

    const regex = await executeMonitor(
      spec({
        name: "regex",
        kind: "file",
        config: { kind: "file", relativePath: "a.txt", watch: "regex", pattern: "hello" },
      }),
      dependencies,
    );
    expect(regex.ok).toBe(true);
  });

  it("probes http, process and system monitors", async () => {
    const workspace = await createTestDirectory("monitor-probes");
    directories.push(workspace);
    const processProbe: ProcessProbe = {
      isAlive: () => true,
      isPortOpen: async () => false,
    };
    const systemMetrics: SystemMetricsProvider = {
      getMetric: (metric) => (metric === "token-usage" ? 42 : undefined),
    };
    const dependencies: MonitorExecutorDependencies = {
      workspaceRoot: workspace,
      httpProbe: async () => ({ status: 204 }),
      processProbe,
      systemMetrics,
      now: () => new Date(now),
    };

    const http = await executeMonitor(
      spec({ name: "http", kind: "http", config: { kind: "http", url: "https://example.com", method: "GET", expectedStatus: 204 } }),
      dependencies,
    );
    expect(http.ok).toBe(true);
    expect(http.numericValue).toBe(204);

    const process = await executeMonitor(
      spec({ name: "process", kind: "process", config: { kind: "process", pid: 123 } }),
      dependencies,
    );
    expect(process.ok).toBe(true);

    const port = await executeMonitor(
      spec({ name: "port", kind: "process", config: { kind: "process", port: 3000 } }),
      dependencies,
    );
    expect(port.ok).toBe(false);

    const system = await executeMonitor(
      spec({ name: "system", kind: "system", config: { kind: "system", metric: "token-usage" } }),
      dependencies,
    );
    expect(system.ok).toBe(true);
    expect(system.numericValue).toBe(42);
  });

  it("reports missing files and blocked private HTTP targets", async () => {
    const workspace = await createTestDirectory("monitor-errors");
    directories.push(workspace);
    const missing = await executeMonitor(
      spec({ name: "missing", kind: "file", config: { kind: "file", relativePath: "missing.txt", watch: "size" } }),
      { workspaceRoot: workspace, now: () => new Date(now) },
    );
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe("LITE_FILE_NOT_FOUND");

    const blocked = await executeMonitor(
      spec({ name: "private", kind: "http", config: { kind: "http", url: "http://127.0.0.1:3000", method: "GET" } }),
      { workspaceRoot: workspace, now: () => new Date(now) },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.errorCode).toBe("LITE_MONITOR_SSRF_BLOCKED");
    expect(isPrivateHttpTarget(new URL("http://192.168.1.10"))).toBe(true);
  });
});
