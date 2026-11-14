import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafePathSegment,
  resolveLitePaths,
} from "../../src/persistence/lite-paths.js";
import { createTestDirectory, removeTestDirectory } from "./test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function workspace(): Promise<string> {
  const directory = await createTestDirectory("paths");
  directories.push(directory);
  return directory;
}

describe("resolveLitePaths", () => {
  it("resolves a project-local state layout", async () => {
    const root = await workspace();
    const paths = resolveLitePaths({
      stateDirectory: ".astarray-lite",
      workspaceRootPath: root,
    });

    expect(paths.workspaceRoot).toBe(path.resolve(root));
    expect(paths.stateRoot).toBe(path.join(path.resolve(root), ".astarray-lite"));
    expect(paths.lockFile).toBe(path.join(paths.stateRoot, "locks", "kernel.lock"));
    expect(paths.inboxJournalFile).toBe(path.join(paths.stateRoot, "inbox", "journal.jsonl"));
  });

  it("accepts an absolute state directory inside the workspace", async () => {
    const root = await workspace();
    const stateRoot = path.join(root, "state");
    const paths = resolveLitePaths({ stateDirectory: stateRoot, workspaceRootPath: root });
    expect(paths.stateRoot).toBe(stateRoot);
  });

  it("accepts an explicit external state directory", async () => {
    const root = await workspace();
    const external = path.resolve(root, "..", "external-agent-state");
    const paths = resolveLitePaths({
      stateDirectory: external,
      workspaceRootPath: root,
      allowExternalStateDirectory: true,
    });
    expect(paths.workspaceRoot).toBe(path.resolve(root));
    expect(paths.stateRoot).toBe(external);
  });

  it("rejects an external state directory unless explicitly allowed", async () => {
    const root = await workspace();
    const external = path.resolve(root, "..", "external-agent-state");
    expect(() =>
      resolveLitePaths({ stateDirectory: external, workspaceRootPath: root }),
    ).toThrow(/LITE_PATH_OUT_OF_WORKSPACE|child of workspaceRootPath/u);
  });

  it("rejects a state directory that contains the workspace", async () => {
    const root = await workspace();
    expect(() =>
      resolveLitePaths({
        stateDirectory: path.dirname(root),
        workspaceRootPath: root,
        allowExternalStateDirectory: true,
      }),
    ).toThrow(/LITE_PATH_OUT_OF_WORKSPACE|must not contain/u);
  });

  it("rejects a state directory that escapes the workspace", async () => {
    const root = await workspace();
    expect(() =>
      resolveLitePaths({ stateDirectory: "../outside", workspaceRootPath: root }),
    ).toThrow(/LITE_PATH_OUT_OF_WORKSPACE|child of workspaceRootPath/u);
  });

  it("rejects the workspace root itself as the state directory", async () => {
    const root = await workspace();
    expect(() =>
      resolveLitePaths({ stateDirectory: ".", workspaceRootPath: root }),
    ).toThrow();
  });
});

describe("assertSafePathSegment", () => {
  it("accepts an identifier", () => {
    expect(() => assertSafePathSegment("tsk_01JABCDEFG", "taskId")).not.toThrow();
  });

  it("rejects traversal and separators", () => {
    for (const value of ["..", ".", "a/b", "a\\b", "a\u0000b"]) {
      expect(() => assertSafePathSegment(value, "taskId")).toThrow();
    }
  });

  it("rejects Windows reserved names", () => {
    expect(() => assertSafePathSegment("CON", "taskId")).toThrow();
  });
});
