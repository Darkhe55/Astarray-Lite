import { promises as fs } from "node:fs";
import net from "node:net";

import { LiteError } from "../contracts/errors.js";
import { sha256Digest } from "../context/hash.js";
import type { LiteMonitorSpec } from "./monitor-registry.js";
import { NodeShellProcessRunner, type ShellProcessRunner } from "../tools/builtin/shell-tool.js";
import { buildShellEnvironment } from "../tools/builtin/shell-policy.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "../tools/builtin/path-safety.js";

const MAXIMUM_FILE_MONITOR_BYTES = 1024 * 1024;
const MAXIMUM_SAMPLE_CHARACTERS = 1_000;

export interface LiteMonitorSample {
  readonly schemaVersion: 1;
  readonly monitorId: string;
  readonly sampledAtIso: string;
  readonly ok: boolean;
  readonly value: string;
  readonly numericValue?: number;
  readonly errorCode?: string;
  readonly durationMilliseconds: number;
}

export interface HttpProbeResult {
  readonly status: number;
  readonly bodyText?: string;
}

export type HttpProbe = (
  url: string,
  method: "GET" | "HEAD",
  timeoutMilliseconds: number,
) => Promise<HttpProbeResult>;

export interface ProcessProbe {
  isAlive(pid: number): boolean;
  isPortOpen(port: number, host: string | undefined): Promise<boolean>;
}

export interface SystemMetricsProvider {
  getMetric(metric: "queue-depth" | "token-usage" | "active-task-age"): number | string | undefined;
}

export interface MonitorExecutorDependencies {
  readonly workspaceRoot: string;
  readonly shellRunner?: ShellProcessRunner;
  readonly httpProbe?: HttpProbe;
  readonly processProbe?: ProcessProbe;
  readonly systemMetrics?: SystemMetricsProvider;
  readonly now?: () => Date;
}

function clip(value: string): string {
  return value.length <= MAXIMUM_SAMPLE_CHARACTERS ? value : `${value.slice(0, MAXIMUM_SAMPLE_CHARACTERS)}...[truncated]`;
}

function sample(
  spec: LiteMonitorSpec,
  input: {
    readonly ok: boolean;
    readonly value: string;
    readonly numericValue?: number;
    readonly errorCode?: string;
    readonly startedAt: number;
    readonly now: () => Date;
  },
): LiteMonitorSample {
  return {
    schemaVersion: 1,
    monitorId: spec.monitorId,
    sampledAtIso: input.now().toISOString(),
    ok: input.ok,
    value: clip(input.value),
    ...(input.numericValue === undefined ? {} : { numericValue: input.numericValue }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    durationMilliseconds: Math.max(0, Date.now() - input.startedAt),
  };
}

export function isPrivateHttpTarget(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host.endsWith(".localhost")) {
    return true;
  }
  if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./u.test(host)) return true;
  return false;
}

const defaultHttpProbe: HttpProbe = async (url, method, timeoutMilliseconds) => {
  const parsed = new URL(url);
  if (isPrivateHttpTarget(parsed)) {
    throw new LiteError("LITE_MONITOR_SSRF_BLOCKED", "private network targets are blocked");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
    });
    return { status: response.status };
  } finally {
    clearTimeout(timer);
  }
};

const defaultProcessProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: unknown }).code === "EPERM";
    }
  },
  async isPortOpen(port, host) {
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, ...(host === undefined ? {} : { host }) });
      const done = (value: boolean): void => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1_000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  },
};

const defaultSystemMetrics: SystemMetricsProvider = {
  getMetric: () => undefined,
};

export async function executeMonitor(
  spec: LiteMonitorSpec,
  dependencies: MonitorExecutorDependencies,
  signal?: AbortSignal,
): Promise<LiteMonitorSample> {
  const startedAt = Date.now();
  const now = dependencies.now ?? (() => new Date());
  try {
    switch (spec.config.kind) {
      case "command": {
        const runner = dependencies.shellRunner ?? new NodeShellProcessRunner();
        const cwd = await resolveWorkspacePath({
          workspaceRoot: dependencies.workspaceRoot,
          relativePath: spec.config.workingDirectory,
        });
        const environment = buildShellEnvironment(spec.config.environmentVariableNames);
        const result = await runner.run({
          command: spec.config.command,
          cwd,
          environment,
          timeoutMilliseconds: spec.timeoutSeconds * 1_000,
          signal: signal ?? new AbortController().signal,
        });
        const ok = result.exitCode === 0 && !result.timedOut && !result.wasAborted;
        return sample(spec, {
          ok,
          value: clip(result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`),
          numericValue: result.exitCode,
          ...(ok ? {} : { errorCode: result.timedOut ? "LITE_SHELL_TIMEOUT" : "LITE_MONITOR_SAMPLE_FAILED" }),
          startedAt,
          now,
        });
      }
      case "file": {
        const absolutePath = await resolveWorkspacePath({
          workspaceRoot: dependencies.workspaceRoot,
          relativePath: spec.config.relativePath,
        });
        assertNotSensitivePath(absolutePath);
        let stat;
        try {
          stat = await fs.lstat(absolutePath);
        } catch {
          return sample(spec, {
            ok: false,
            value: "missing",
            errorCode: "LITE_FILE_NOT_FOUND",
            startedAt,
            now,
          });
        }
        if (!stat.isFile()) {
          return sample(spec, { ok: false, value: "not a regular file", errorCode: "LITE_FILE_NOT_FOUND", startedAt, now });
        }
        if (spec.config.watch === "mtime") {
          return sample(spec, { ok: true, value: stat.mtime.toISOString(), numericValue: stat.mtimeMs, startedAt, now });
        }
        if (spec.config.watch === "size") {
          return sample(spec, { ok: true, value: String(stat.size), numericValue: stat.size, startedAt, now });
        }
        if (stat.size > MAXIMUM_FILE_MONITOR_BYTES) {
          return sample(spec, { ok: false, value: "file too large", errorCode: "LITE_FILE_TOO_LARGE", startedAt, now });
        }
        const content = await fs.readFile(absolutePath, "utf8");
        if (spec.config.watch === "content-hash") {
          return sample(spec, { ok: true, value: sha256Digest(content), startedAt, now });
        }
        const pattern = new RegExp(spec.config.pattern ?? "", "u");
        const matched = pattern.test(content);
        return sample(spec, { ok: matched, value: matched ? "matched" : "not matched", startedAt, now });
      }
      case "http": {
        const probe = dependencies.httpProbe ?? defaultHttpProbe;
        const result = await probe(spec.config.url, spec.config.method, spec.timeoutSeconds * 1_000);
        const expected = spec.config.expectedStatus ?? 200;
        const ok = result.status === expected;
        return sample(spec, {
          ok,
          value: `HTTP ${result.status}`,
          numericValue: result.status,
          ...(ok ? {} : { errorCode: "LITE_MONITOR_SAMPLE_FAILED" }),
          startedAt,
          now,
        });
      }
      case "process": {
        const probe = dependencies.processProbe ?? defaultProcessProbe;
        if (spec.config.pid !== undefined) {
          const alive = probe.isAlive(spec.config.pid);
          return sample(spec, {
            ok: alive,
            value: alive ? `pid ${spec.config.pid} alive` : `pid ${spec.config.pid} not found`,
            ...(alive ? {} : { errorCode: "LITE_MONITOR_SAMPLE_FAILED" }),
            startedAt,
            now,
          });
        }
        if (spec.config.port !== undefined) {
          const open = await probe.isPortOpen(spec.config.port, spec.config.host);
          return sample(spec, {
            ok: open,
            value: open ? `port ${spec.config.port} open` : `port ${spec.config.port} closed`,
            ...(open ? {} : { errorCode: "LITE_MONITOR_SAMPLE_FAILED" }),
            startedAt,
            now,
          });
        }
        return sample(spec, { ok: false, value: "no pid or port", errorCode: "LITE_MONITOR_SAMPLE_FAILED", startedAt, now });
      }
      case "system": {
        const metrics = dependencies.systemMetrics ?? defaultSystemMetrics;
        const value = metrics.getMetric(spec.config.metric);
        if (value === undefined) {
          return sample(spec, { ok: false, value: "unavailable", errorCode: "LITE_MONITOR_SAMPLE_FAILED", startedAt, now });
        }
        return sample(spec, {
          ok: true,
          value: String(value),
          ...(typeof value === "number" ? { numericValue: value } : {}),
          startedAt,
          now,
        });
      }
    }
  } catch (error) {
    return sample(spec, {
      ok: false,
      value: "sample failed",
      errorCode: error instanceof LiteError ? error.code : "LITE_MONITOR_SAMPLE_FAILED",
      startedAt,
      now,
    });
  }
  return sample(spec, {
    ok: false,
    value: "unsupported monitor kind",
    errorCode: "LITE_MONITOR_SAMPLE_FAILED",
    startedAt,
    now,
  });
}
