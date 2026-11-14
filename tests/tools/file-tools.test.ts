import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerFileTools } from "../../src/tools/builtin/file-tools.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(): Promise<{
  readonly workspace: string;
  readonly stateRoot: string;
  readonly executor: ToolExecutor;
}> {
  const workspace = await createTestDirectory("file-tools");
  directories.push(workspace);
  const stateRoot = path.join(workspace, ".astarray-lite");
  const registry = new ToolRegistry();
  registerFileTools(registry, { workspaceRoot: workspace, stateRoot });
  return { workspace, stateRoot, executor: new ToolExecutor({ registry }) };
}

function call(
  executor: ToolExecutor,
  toolName: string,
  argumentsValue: unknown,
): Promise<import("../../src/tools/tool-types.js").LiteToolExecutionResult> {
  return executor.execute({
    callId: "call-1",
    toolName,
    argumentsJson: JSON.stringify(argumentsValue),
  });
}

describe("file tools", () => {
  it("writes, reads and lists files", async () => {
    const { workspace, executor } = await setup();
    const write = await call(executor, "write_file", {
      path: "src/a.txt",
      content: "alpha\nbeta\n",
    });
    expect(write.ok).toBe(true);
    expect(await fs.readFile(path.join(workspace, "src", "a.txt"), "utf8")).toBe("alpha\nbeta\n");

    const read = await call(executor, "read_file", { path: "src/a.txt" });
    expect(read.ok).toBe(true);
    expect(read.outputText).toContain("1 | alpha");
    expect(read.outputText).toContain("2 | beta");

    const list = await call(executor, "list_directory", { path: "src" });
    expect(list.outputText).toContain("f a.txt");
  });

  it("pages read output", async () => {
    const { executor } = await setup();
    await call(executor, "write_file", {
      path: "lines.txt",
      content: "1\n2\n3\n4\n5\n",
    });
    const read = await call(executor, "read_file", { path: "lines.txt", offset: 2, limit: 2 });
    expect(read.outputText).toContain("2 | 2");
    expect(read.outputText).toContain("3 | 3");
    expect(read.outputText).not.toContain("4 | 4");
  });

  it("backs up an existing file before overwrite and replace", async () => {
    const { workspace, stateRoot, executor } = await setup();
    await call(executor, "write_file", { path: "a.txt", content: "one" });
    await call(executor, "write_file", { path: "a.txt", content: "two" });

    const replace = await call(executor, "replace_in_file", {
      path: "a.txt",
      oldText: "two",
      newText: "three",
    });
    expect(replace.ok).toBe(true);
    expect(await fs.readFile(path.join(workspace, "a.txt"), "utf8")).toBe("three");

    const backups = await fs.readdir(path.join(stateRoot, "file-backups"));
    expect(backups.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects count mismatches and traversal", async () => {
    const { executor } = await setup();
    await call(executor, "write_file", { path: "a.txt", content: "one" });

    const mismatch = await call(executor, "replace_in_file", {
      path: "a.txt",
      oldText: "one",
      newText: "two",
      expectedReplacements: 2,
    });
    expect(mismatch.errorCode).toBe("LITE_REPLACE_COUNT_MISMATCH");

    const traversal = await call(executor, "read_file", { path: "../outside.txt" });
    expect(traversal.errorCode).toBe("LITE_PATH_OUT_OF_WORKSPACE");
  });

  it("blocks sensitive and binary files", async () => {
    const { workspace, executor } = await setup();
    const sensitive = await call(executor, "write_file", { path: ".env", content: "SECRET=1" });
    expect(sensitive.errorCode).toBe("LITE_SENSITIVE_CONTENT_BLOCKED");

    await fs.writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
    const binary = await call(executor, "read_file", { path: "binary.bin" });
    expect(binary.errorCode).toBe("LITE_FILE_BINARY_UNSUPPORTED");
  });

  it("blocks the kernel state directory", async () => {
    const { stateRoot, executor } = await setup();
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(path.join(stateRoot, "state.json"), "{}", "utf8");

    const read = await call(executor, "read_file", { path: ".astarray-lite/state.json" });
    expect(read.errorCode).toBe("LITE_PATH_OUT_OF_WORKSPACE");
    const list = await call(executor, "list_directory", { path: ".astarray-lite" });
    expect(list.errorCode).toBe("LITE_PATH_OUT_OF_WORKSPACE");
    const write = await call(executor, "write_file", {
      path: ".astarray-lite/state.json",
      content: "{}",
    });
    expect(write.errorCode).toBe("LITE_PATH_OUT_OF_WORKSPACE");
  });
});
