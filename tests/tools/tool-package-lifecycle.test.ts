import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Buffer } from "../../src/context/hash.js";
import { resolveLitePaths, type LitePaths } from "../../src/persistence/lite-paths.js";
import {
  ToolPackageService,
  computeToolPackageHash,
  type ToolPackageManifest,
} from "../../src/tools/tool-package-service.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

function buildPackage(input: { readonly isBuiltIn?: boolean } = {}): {
  readonly manifest: ToolPackageManifest;
  readonly files: ReadonlyMap<string, Buffer>;
} {
  const files = new Map([["tools/run.js", Buffer.from("run")]]);
  const base = {
    schemaVersion: 1 as const,
    packageId: "demo.pkg",
    version: "1.0.0",
    name: "Demo",
    description: "demo",
    tools: [
      { name: "demo__run", summary: "run", capability: "process.shell" as const, inputSchema: { type: "object" } },
    ],
    files: [...files.entries()].map(([filePath, buffer]) => ({
      path: filePath,
      sha256: sha256Buffer(buffer),
      sizeBytes: buffer.byteLength,
    })),
    ...(input.isBuiltIn === true ? { isBuiltIn: true } : {}),
  };
  return {
    manifest: { ...base, packageHash: computeToolPackageHash(base) },
    files,
  };
}

async function setup(): Promise<{ service: ToolPackageService; paths: LitePaths }> {
  const workspace = await createTestDirectory("package-lifecycle");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  return { service: new ToolPackageService({ paths }), paths };
}

async function install(service: ToolPackageService, isBuiltIn = false) {
  const { manifest, files } = buildPackage({ isBuiltIn });
  return service.install({
    manifestJson: JSON.stringify(manifest),
    files,
    approval: "allow-once",
  });
}

describe("tool package lifecycle", () => {
  it("enables and disables tools in the schema", async () => {
    const { service } = await setup();
    await install(service);
    expect(await service.getEnabledToolDefinitions()).toEqual([]);

    await service.setEnabled("demo.pkg", "1.0.0", true);
    const enabled = await service.getEnabledToolDefinitions();
    expect(enabled.map((tool) => tool.name)).toEqual(["demo__run"]);
    expect(await service.getToolsetRevision()).toBeGreaterThan(1);

    await service.setEnabled("demo.pkg", "1.0.0", false);
    expect(await service.getEnabledToolDefinitions()).toEqual([]);
  });

  it("persists lifecycle state across service instances", async () => {
    const { service, paths } = await setup();
    await install(service);
    await service.setEnabled("demo.pkg", "1.0.0", true);
    const revision = await service.getToolsetRevision();

    const reloaded = new ToolPackageService({ paths });
    expect((await reloaded.listInstalled())[0]?.isEnabled).toBe(true);
    expect(await reloaded.getToolsetRevision()).toBe(revision);
  });

  it("rejects deleting built-in packages", async () => {
    const { service } = await setup();
    await install(service, true);
    await expect(service.delete("demo.pkg", "1.0.0")).rejects.toMatchObject({
      code: "LITE_TOOL_PACKAGE_INSTALL_DENIED",
    });
  });

  it("backs up before deleting a non-built-in package and bumps revision", async () => {
    const { service, paths } = await setup();
    await install(service);
    const before = await service.getToolsetRevision();
    await service.delete("demo.pkg", "1.0.0");

    expect(await service.getToolsetRevision()).toBe(before + 1);
    expect(await service.listInstalled()).toEqual([]);
    const packageDirectory = path.join(paths.toolPackagesDirectory, "demo.pkg", "1.0.0");
    expect(await fs.stat(packageDirectory).then(() => true, () => false)).toBe(false);
    const backupRoot = path.join(paths.backupsDirectory, "tool-packages", "demo.pkg");
    expect(await fs.readdir(backupRoot)).toHaveLength(1);
  });
});
