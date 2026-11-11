import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Buffer } from "../../src/context/hash.js";
import { resolveLitePaths } from "../../src/persistence/lite-paths.js";
import {
  ToolPackageService,
  computeToolPackageHash,
  parseToolPackageManifest,
  validateArchivePath,
  type ToolPackageManifest,
} from "../../src/tools/tool-package-service.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

function manifestFor(files: ReadonlyMap<string, Buffer>, overrides: Partial<ToolPackageManifest> = {}): ToolPackageManifest {
  const base = {
    schemaVersion: 1 as const,
    packageId: "demo.pkg",
    version: "1.0.0",
    name: "Demo package",
    description: "demo",
    tools: [
      {
        name: "demo__run",
        summary: "run demo",
        capability: "process.shell" as const,
        inputSchema: { type: "object" },
      },
    ],
    files: [...files.entries()].map(([filePath, buffer]) => ({
      path: filePath,
      sha256: sha256Buffer(buffer),
      sizeBytes: buffer.byteLength,
    })),
  };
  const candidate = { ...base, ...overrides };
  return {
    ...candidate,
    packageHash: computeToolPackageHash(candidate),
  };
}

async function setup(): Promise<{ service: ToolPackageService; workspace: string }> {
  const workspace = await createTestDirectory("tool-package");
  directories.push(workspace);
  const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
  return { service: new ToolPackageService({ paths }), workspace };
}

describe("tool package manifests", () => {
  it("parses and previews a valid package", async () => {
    const { service } = await setup();
    const files = new Map([["tools/run.js", Buffer.from("console.log('x')")]]);
    const manifest = manifestFor(files);
    const preview = service.preview({ manifestJson: JSON.stringify(manifest), files });
    expect(preview.fileCount).toBe(1);
    expect(preview.totalBytes).toBe(files.get("tools/run.js")?.byteLength);
    expect(preview.capabilities).toEqual(["process.shell"]);
    expect(preview.requiresAllowOnce).toBe(true);
  });

  it("rejects invalid manifests and hash mismatches", async () => {
    const { service } = await setup();
    const files = new Map([["tools/run.js", Buffer.from("x")]]);
    expect(() => parseToolPackageManifest("not-json")).toThrow(/valid JSON/u);
    expect(() =>
      service.preview({ manifestJson: JSON.stringify({ ...manifestFor(files), packageHash: `sha256:${"0".repeat(64)}` }), files }),
    ).toThrow(/package hash/u);

    const tampered = manifestFor(files, {
      files: [{ path: "tools/run.js", sha256: `sha256:${"a".repeat(64)}`, sizeBytes: 1 }],
    });
    expect(() => service.preview({ manifestJson: JSON.stringify(tampered), files })).toThrow(
      /file hash mismatch/u,
    );
  });

  it("rejects zip-slip paths, oversized packages and extra files", async () => {
    expect(() => validateArchivePath("../evil.js")).toThrow(/escapes/u);
    expect(() => validateArchivePath("/etc/passwd")).toThrow(/relative/u);
    expect(() => validateArchivePath(["C:", "tmp", "x"].join("\\"))).toThrow(/relative/u);
    expect(() => validateArchivePath("tools/../../evil.js")).toThrow(/escapes/u);

    const { service } = await setup();
    const files = new Map([
      ["a.txt", Buffer.from("a")],
      ["b.txt", Buffer.from("b")],
    ]);
    const manifest = manifestFor(files);
    const small = new ToolPackageService({
      paths: resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: directories[0] ?? "." }),
      maximumFiles: 1,
    });
    expect(() => small.preview({ manifestJson: JSON.stringify(manifest), files })).toThrow(
      /too many files/u,
    );
    expect(() =>
      service.preview({
        manifestJson: JSON.stringify(manifestFor(new Map([["a.txt", Buffer.from("a")]]))),
        files,
      }),
    ).toThrow(/file set/u);
  });
});

describe("tool package installation", () => {
  it("requires allow-once and installs disabled by default", async () => {
    const { service, workspace } = await setup();
    const files = new Map([["tools/run.js", Buffer.from("x")]]);
    const manifest = manifestFor(files);
    const input = { manifestJson: JSON.stringify(manifest), files };

    await expect(service.install({ ...input, approval: "deny" })).rejects.toMatchObject({
      code: "LITE_TOOL_PACKAGE_INSTALL_DENIED",
    });
    const installed = await service.install({ ...input, approval: "allow-once" });
    expect(installed.isEnabled).toBe(false);
    expect(installed.packageId).toBe("demo.pkg");
    const target = path.join(workspace, ".astarray-lite", "tool-packages", "demo.pkg", "1.0.0");
    expect(await fs.stat(path.join(target, "install.json")).then(() => true, () => false)).toBe(true);
    expect(await fs.readFile(path.join(target, "files", "tools", "run.js"), "utf8")).toBe("x");
  });
});
