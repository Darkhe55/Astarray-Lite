import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNotSensitivePath,
  isSensitiveFilePath,
  resolveWorkspacePath,
} from "../../src/tools/builtin/path-safety.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function workspace(): Promise<string> {
  const root = await createTestDirectory("path-safety");
  directories.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
  return root;
}

describe("resolveWorkspacePath", () => {
  it("resolves a relative path inside the workspace", async () => {
    const root = await workspace();
    const resolved = await resolveWorkspacePath({
      workspaceRoot: root,
      relativePath: "src/index.ts",
    });
    expect(resolved).toBe(path.join(root, "src", "index.ts"));
  });

  it("rejects absolute and traversing paths", async () => {
    const root = await workspace();
    await expect(
      resolveWorkspacePath({ workspaceRoot: root, relativePath: "../outside.txt" }),
    ).rejects.toMatchObject({ code: "LITE_PATH_OUT_OF_WORKSPACE" });
    await expect(
      resolveWorkspacePath({ workspaceRoot: root, relativePath: path.join(root, "x") }),
    ).rejects.toMatchObject({ code: "LITE_PATH_OUT_OF_WORKSPACE" });
  });

  it("detects sensitive file names", () => {
    expect(isSensitiveFilePath(".env")).toBe(true);
    expect(isSensitiveFilePath("secrets.pem")).toBe(true);
    expect(isSensitiveFilePath("src/index.ts")).toBe(false);
    expect(() => assertNotSensitivePath(".env")).toThrow(/sensitive/u);
  });
});
