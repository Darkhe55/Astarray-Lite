import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand, runLiteCommand } from "../../src/cli/lite-command.js";
import { FakeProvider } from "../../src/runtime/fake-provider.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

describe("lite CLI", () => {
  it("enqueues a task with stable JSON", async () => {
    const result = await runLiteCommand(["run", "--kernel", "lite", "--enqueue", "--json", "hello"]);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.output) as {
      ok: boolean;
      kernel: string;
      command: string;
      mode: string;
      result: { taskIdentifier: string; status: string };
    };
    expect(output.ok).toBe(true);
    expect(output.kernel).toBe("lite");
    expect(output.command).toBe("run");
    expect(output.mode).toBe("enqueue");
    expect(output.result.status).toBe("queued");
    expect(output.result.taskIdentifier).toBe("cli-task");
  });

  it("executes a real turn with an injected provider", async () => {
    const workspace = await createTestDirectory("cli-execute");
    directories.push(workspace);
    const provider = new FakeProvider([{ kind: "text", text: "answer" }]);
    const result = await runLiteCommand(["run", "--kernel", "lite", "--json", "hello"], {
      provider,
      cwd: workspace,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      kernel: "lite",
      mode: "execute",
      outcome: "completed",
      text: "answer",
    });
  });

  it("supports human-readable run and goals output", async () => {
    const workspace = await createTestDirectory("cli-human");
    directories.push(workspace);
    const provider = new FakeProvider([{ kind: "text", text: "human answer" }]);
    const run = await runLiteCommand(["run", "--kernel", "lite", "hello"], {
      provider,
      cwd: workspace,
    });
    expect(run.output).toBe("human answer");
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

  it("exports a redacted diagnostics bundle without a provider", async () => {
    const workspace = await createTestDirectory("cli-diagnostics");
    directories.push(workspace);
    const result = await runLiteCommand(
      ["diagnostics", "--kernel", "lite", "--json", "--out", "diag.json"],
      { cwd: workspace },
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.output) as { ok: boolean; path: string };
    expect(output.ok).toBe(true);
    expect(await fs.readFile(output.path, "utf8")).toContain("astarray-lite");
  });

  it("keeps the default core path unchanged for this package", async () => {
    const result = await runCommand(["run", "hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("core kernel");
    const lite = await runCommand(["run", "--kernel", "lite", "--enqueue", "--json", "hello"]);
    expect(lite.exitCode).toBe(0);
    expect(JSON.parse(lite.output).kernel).toBe("lite");
  });
});
