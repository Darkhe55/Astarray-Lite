import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";

import { LiteError } from "../../contracts/errors.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { LiteToolHandlerResult, LiteToolSpec } from "../tool-types.js";
import { resolveWorkspacePath } from "./path-safety.js";
import {
  assertShellCommandAllowed,
  buildShellEnvironment,
  normalizeShellCommandForAudit,
} from "./shell-policy.js";

const MAXIMUM_STREAM_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAXIMUM_TIMEOUT_SECONDS = 600;

export interface ShellRunRequest {
  readonly command: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly signal: AbortSignal;
}

export interface ShellRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly wasAborted: boolean;
}

export interface ShellProcessRunner {
  run(request: ShellRunRequest): Promise<ShellRunResult>;
}

function appendCapped(
  current: string,
  chunk: Buffer,
  truncated: { value: boolean },
): string {
  if (truncated.value) return current;
  const remaining = MAXIMUM_STREAM_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) {
    truncated.value = true;
    return current;
  }
  if (chunk.length > remaining) {
    truncated.value = true;
    return current + chunk.subarray(0, remaining).toString("utf8");
  }
  return current + chunk.toString("utf8");
}

function killProcessTree(child: {
  readonly pid?: number | undefined;
  readonly kill?: (signal?: NodeJS.Signals | number) => boolean;
}): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => undefined);
    } catch {
      // Best-effort; the child may already be gone.
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill?.("SIGKILL");
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Production process runner. Commands run with a sanitized environment, a
 * workspace cwd, capped output and a hard timeout; interactive stdin is closed.
 */
export class NodeShellProcessRunner implements ShellProcessRunner {
  run(request: ShellRunRequest): Promise<ShellRunResult> {
    return new Promise<ShellRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(request.command, {
          cwd: request.cwd,
          env: request.environment,
          shell: true,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          new LiteError(
            (error as { code?: unknown }).code === "EPERM"
              ? "LITE_SHELL_SANDBOX_UNAVAILABLE"
              : "LITE_TOOL_EXECUTION_FAILED",
            "could not start the shell process",
          ),
        );
        return;
      }

      let stdout = "";
      let stderr = "";
      const stdoutTruncated = { value: false };
      const stderrTruncated = { value: false };
      let settled = false;
      let timedOut = false;
      let wasAborted = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const settle = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        request.signal.removeEventListener("abort", onAbort);
        resolve({
          stdout: `${stdout}${stdoutTruncated.value ? "\n[truncated]" : ""}`,
          stderr: `${stderr}${stderrTruncated.value ? "\n[truncated]" : ""}`,
          exitCode,
          timedOut,
          wasAborted,
        });
      };

      const onAbort = (): void => {
        wasAborted = true;
        killProcessTree(child);
        settle(124);
      };

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        settle(124);
      }, request.timeoutMilliseconds);

      if (request.signal.aborted) {
        onAbort();
      } else {
        request.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk, stdoutTruncated);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk, stderrTruncated);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        request.signal.removeEventListener("abort", onAbort);
        reject(
          new LiteError(
            error.code === "EPERM" || error.code === "EACCES"
              ? "LITE_SHELL_SANDBOX_UNAVAILABLE"
              : "LITE_TOOL_EXECUTION_FAILED",
            "shell process failed",
          ),
        );
      });
      child.on("close", (code: number | null) => {
        settle(code ?? 1);
      });
    });
  }
}

export interface ShellToolOptions {
  readonly workspaceRoot: string;
  readonly runner?: ShellProcessRunner;
  readonly environmentSource?: NodeJS.ProcessEnv;
  readonly maximumTimeoutSeconds?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

export function registerShellTool(registry: ToolRegistry, options: ShellToolOptions): void {
  const runner = options.runner ?? new NodeShellProcessRunner();
  const maximumTimeoutSeconds = options.maximumTimeoutSeconds ?? MAXIMUM_TIMEOUT_SECONDS;

  const tool: LiteToolSpec = {
    name: "shell",
    summary: "Run a non-interactive shell command inside the workspace with a timeout.",
    category: "basic",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: false,
    timeoutMilliseconds: 650_000,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 8_000 },
        workingDirectory: { type: "string", minLength: 1 },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: MAXIMUM_TIMEOUT_SECONDS },
        environmentVariableNames: {
          type: "array",
          items: { type: "string" },
          maxItems: 50,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: async (argumentsValue, context): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const command = typeof record["command"] === "string" ? record["command"] : "";
      assertShellCommandAllowed(command);

      const workingDirectory =
        typeof record["workingDirectory"] === "string" ? record["workingDirectory"] : ".";
      const cwd = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath: workingDirectory,
      });
      const cwdStat = await fs.lstat(cwd).catch(() => undefined);
      if (cwdStat === undefined || !cwdStat.isDirectory()) {
        throw new LiteError("LITE_FILE_NOT_FOUND", "working directory not found");
      }

      const requestedTimeout =
        typeof record["timeoutSeconds"] === "number" ? record["timeoutSeconds"] : DEFAULT_TIMEOUT_SECONDS;
      const timeoutSeconds = Math.min(
        maximumTimeoutSeconds,
        Math.max(1, Math.trunc(requestedTimeout)),
      );
      const names = Array.isArray(record["environmentVariableNames"])
        ? record["environmentVariableNames"].filter((name): name is string => typeof name === "string")
        : [];
      const environment = buildShellEnvironment(names, options.environmentSource ?? process.env);

      const result = await runner.run({
        command,
        cwd,
        environment,
        timeoutMilliseconds: timeoutSeconds * 1_000,
        signal: context.signal,
      });

      if (result.wasAborted) {
        throw new LiteError("LITE_TURN_CANCELLED", "shell command was aborted");
      }
      if (result.timedOut) {
        throw new LiteError("LITE_SHELL_TIMEOUT", "shell command timed out", {
          timeoutSeconds,
          command: normalizeShellCommandForAudit(command),
        });
      }

      const output = [
        `exitCode: ${result.exitCode}`,
        "stdout:",
        result.stdout,
        "stderr:",
        result.stderr,
      ].join("\n");
      return { outputText: output, isError: result.exitCode !== 0 };
    },
  };

  registry.register(tool);
}
