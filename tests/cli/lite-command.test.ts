import { describe, expect, it } from "vitest";

import { runCommand, runLiteCommand } from "../../src/cli/lite-command.js";

describe("lite CLI", () => {
  it("runs a task with stable JSON", async () => {
    const result = await runLiteCommand(["run", "--kernel", "lite", "--json", "hello"]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.output) as {
      ok: boolean;
      kernel: string;
      command: string;
      result: { taskIdentifier: string; status: string };
    };
    expect(output.ok).toBe(true);
    expect(output.kernel).toBe("lite");
    expect(output.command).toBe("run");
    expect(output.result.status).toBe("queued");
    expect(output.result.taskIdentifier).toBe("cli-task");
  });

  it("supports human-readable run and goals output", async () => {
    const run = await runLiteCommand(["run", "--kernel", "lite", "hello"]);
    expect(run.output).toContain("queued");
    const goals = await runLiteCommand(["goals", "--kernel", "lite", "--json"]);
    expect(JSON.parse(goals.output)).toMatchObject({ ok: true, goals: [] });
  });

  it("maps invalid input to a non-zero exit code and JSON error", async () => {
    const result = await runLiteCommand(["run", "--kernel", "lite", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.errorCode).toBe("LITE_USER_MESSAGE_EMPTY");
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { code: "LITE_USER_MESSAGE_EMPTY" },
    });

    const unknown = await runLiteCommand(["bogus", "--kernel", "lite", "--json"]);
    expect(unknown.exitCode).toBe(2);
  });

  it("keeps the default core path unchanged for this package", async () => {
    const result = await runCommand(["run", "hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("core kernel");
    const lite = await runCommand(["run", "--kernel", "lite", "--json", "hello"]);
    expect(lite.exitCode).toBe(0);
    expect(JSON.parse(lite.output).kernel).toBe("lite");
  });
});
