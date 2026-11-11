import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerShellTool, type ShellProcessRunner, type ShellRunRequest, type ShellRunResult } from "../../src/tools/builtin/shell-tool.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

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

async function setup(result: ShellRunResult = {
  stdout: "hello\n",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  wasAborted: false,
}): Promise<{
  readonly workspace: string;
  readonly runner: FakeShellRunner;
  readonly executor: ToolExecutor;
}> {
  const workspace = await createTestDirectory("shell-tool");
  directories.push(workspace);
  const runner = new FakeShellRunner(result);
  const registry = new ToolRegistry();
  registerShellTool(registry, {
    workspaceRoot: workspace,
    runner,
    environmentSource: { PATH: "/bin", CI: "1", SECRET_VALUE: "hidden" },
  });
  return { workspace, runner, executor: new ToolExecutor({ registry }) };
}

function call(
  executor: ToolExecutor,
  argumentsValue: unknown,
): Promise<import("../../src/tools/tool-types.js").LiteToolExecutionResult> {
  return executor.execute({
    callId: "call-1",
    toolName: "shell",
    argumentsJson: JSON.stringify(argumentsValue),
  });
}

describe("shell tool", () => {
  it("runs in the workspace with a sanitized environment", async () => {
    const { workspace, runner, executor } = await setup();
    const result = await call(executor, {
      command: "echo hello",
      environmentVariableNames: ["CI"],
    });

    expect(result.ok).toBe(true);
    expect(result.outputText).toContain("exitCode: 0");
    expect(result.outputText).toContain("hello");
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.cwd).toBe(workspace);
    expect(runner.requests[0]?.environment["CI"]).toBe("1");
    expect(runner.requests[0]?.environment["SECRET_VALUE"]).toBeUndefined();
  });

  it("rejects protected paths, absolute cwd and sensitive env names", async () => {
    const { workspace, executor } = await setup();

    const protectedCommand = await call(executor, {
      command: "cat .astarray-lite/state.json",
    });
    expect(protectedCommand.errorCode).toBe("LITE_PATH_OUT_OF_WORKSPACE");

    const absoluteCwd = await call(executor, {
      command: "pwd",
      workingDirectory: path.join(workspace, "sub"),
    });
    expect(absoluteCwd.errorCode).toBe("LITE_PATH_OUT_OF_WORKSPACE");

    const sensitiveEnv = await call(executor, {
      command: "env",
      environmentVariableNames: ["API_KEY"],
    });
    expect(sensitiveEnv.errorCode).toBe("LITE_SENSITIVE_CONTENT_BLOCKED");
  });

  it("maps timeout and abort results to stable errors", async () => {
    const timedOut = await setup({
      stdout: "",
      stderr: "",
      exitCode: 124,
      timedOut: true,
      wasAborted: false,
    });
    const timeoutResult = await call(timedOut.executor, { command: "sleep 10" });
    expect(timeoutResult.errorCode).toBe("LITE_SHELL_TIMEOUT");

    const aborted = await setup({
      stdout: "",
      stderr: "",
      exitCode: 124,
      timedOut: false,
      wasAborted: true,
    });
    const abortResult = await call(aborted.executor, { command: "sleep 10" });
    expect(abortResult.errorCode).toBe("LITE_TURN_CANCELLED");
  });

  it("returns the exit code and stderr without hiding failures", async () => {
    const { executor } = await setup({
      stdout: "partial",
      stderr: "failed",
      exitCode: 2,
      timedOut: false,
      wasAborted: false,
    });
    const result = await call(executor, { command: "false" });
    expect(result.ok).toBe(false);
    expect(result.outputText).toContain("exitCode: 2");
    expect(result.outputText).toContain("failed");
  });
});
