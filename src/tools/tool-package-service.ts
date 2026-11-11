import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import { canonicalJsonString } from "../context/canonical-json.js";
import { sha256Buffer, sha256Digest } from "../context/hash.js";
import { assertSafePathSegment, type LitePaths } from "../persistence/lite-paths.js";
import { writeJsonAtomic, readJsonWithBackup } from "../persistence/state-store.js";
import { isLiteCapabilityId, type LiteCapabilityId } from "../permissions/capabilities.js";
import type { LiteToolDefinition } from "../context/context-assembler.js";

export interface ToolPackageManifestTool {
  readonly name: string;
  readonly summary: string;
  readonly capability: LiteCapabilityId;
  readonly inputSchema: unknown;
}

export interface ToolPackageManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ToolPackageManifest {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly ToolPackageManifestTool[];
  readonly files: readonly ToolPackageManifestFile[];
  readonly packageHash: string;
  readonly isBuiltIn?: boolean;
}

export interface ToolPackagePreview {
  readonly manifest: ToolPackageManifest;
  readonly capabilities: readonly LiteCapabilityId[];
  readonly warnings: readonly string[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly requiresAllowOnce: true;
}

export interface InstalledToolPackage {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly version: string;
  readonly installedAtIso: string;
  readonly isEnabled: boolean;
  readonly isBuiltIn: boolean;
  readonly packageHash: string;
  readonly capabilities: readonly LiteCapabilityId[];
  readonly directory: string;
}

interface LifecycleFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAtIso: string;
}

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

export function validateArchivePath(entryPath: string): void {
  if (entryPath.trim() === "" || entryPath.includes("\0")) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "archive path is empty or invalid");
  }
  if (path.isAbsolute(entryPath) || /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(entryPath)) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "archive path must be relative");
  }
  const normalized = path.posix.normalize(entryPath.replace(/\\/gu, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "archive path escapes the package root");
  }
  if (normalized.split("/").includes("..")) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "archive path escapes the package root");
  }
}

export function computeToolPackageHash(
  manifest: Omit<ToolPackageManifest, "packageHash">,
): string {
  return sha256Digest(canonicalJsonString(manifest));
}

export function parseToolPackageManifest(json: string): ToolPackageManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "manifest is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "manifest must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "unsupported manifest schema");
  }
  const packageId = requireString(record, "packageId");
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "packageId is invalid");
  }
  const version = requireString(record, "version");
  if (!VERSION_PATTERN.test(version)) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "version is invalid");
  }
  if (!Array.isArray(record["tools"]) || record["tools"].length === 0) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "manifest must declare at least one tool");
  }
  const toolNames = new Set<string>();
  const tools = record["tools"].map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "tool entry is invalid");
    }
    const tool = entry as Record<string, unknown>;
    const name = requireString(tool, "name");
    if (toolNames.has(name)) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "tool names must be unique");
    }
    toolNames.add(name);
    const capability = requireString(tool, "capability");
    if (!isLiteCapabilityId(capability)) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "tool capability is unknown");
    }
    return {
      name,
      summary: typeof tool["summary"] === "string" ? tool["summary"] : "",
      capability,
      inputSchema: tool["inputSchema"] ?? { type: "object" },
    };
  });
  if (!Array.isArray(record["files"])) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "manifest files must be an array");
  }
  const filePaths = new Set<string>();
  const files = record["files"].map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "file entry is invalid");
    }
    const file = entry as Record<string, unknown>;
    const filePath = requireString(file, "path");
    validateArchivePath(filePath);
    if (filePaths.has(filePath)) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "file paths must be unique");
    }
    filePaths.add(filePath);
    const hash = requireString(file, "sha256");
    if (!HASH_PATTERN.test(hash)) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "file hash is invalid");
    }
    const sizeBytes = file["sizeBytes"];
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "file size is invalid");
    }
    return { path: filePath, sha256: hash, sizeBytes };
  });
  const packageHash = requireString(record, "packageHash");
  if (!HASH_PATTERN.test(packageHash)) {
    throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "packageHash is invalid");
  }
  return {
    schemaVersion: 1,
    packageId,
    version,
    name: requireString(record, "name"),
    description: typeof record["description"] === "string" ? record["description"] : "",
    tools,
    files,
    packageHash,
    ...(record["isBuiltIn"] === true ? { isBuiltIn: true } : {}),
  };
}

export interface ToolPackageServiceOptions {
  readonly paths: LitePaths;
  readonly now?: () => Date;
  readonly maximumFiles?: number;
  readonly maximumTotalBytes?: number;
}

export class ToolPackageService {
  private readonly paths: LitePaths;
  private readonly now: () => Date;
  private readonly maximumFiles: number;
  private readonly maximumTotalBytes: number;

  constructor(options: ToolPackageServiceOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.maximumFiles = options.maximumFiles ?? 500;
    this.maximumTotalBytes = options.maximumTotalBytes ?? 20 * 1024 * 1024;
  }

  preview(input: {
    readonly manifestJson: string;
    readonly files: ReadonlyMap<string, Buffer>;
  }): ToolPackagePreview {
    const manifest = parseToolPackageManifest(input.manifestJson);
    const computedHash = computeToolPackageHash({
      schemaVersion: manifest.schemaVersion,
      packageId: manifest.packageId,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description,
      tools: manifest.tools,
      files: manifest.files,
      ...(manifest.isBuiltIn === undefined ? {} : { isBuiltIn: manifest.isBuiltIn }),
    });
    if (computedHash !== manifest.packageHash) {
      throw new LiteError("LITE_TOOL_PACKAGE_HASH_MISMATCH", "package hash does not match");
    }
    if (manifest.files.length > this.maximumFiles) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "package contains too many files");
    }
    let totalBytes = 0;
    const expectedPaths = new Set(manifest.files.map((file) => file.path));
    if (input.files.size !== expectedPaths.size) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "package file set does not match the manifest");
    }
    for (const file of manifest.files) {
      const buffer = input.files.get(file.path);
      if (buffer === undefined) {
        throw new LiteError("LITE_TOOL_PACKAGE_INVALID", `missing package file: ${file.path}`);
      }
      totalBytes += buffer.byteLength;
      if (buffer.byteLength !== file.sizeBytes || sha256Buffer(buffer) !== file.sha256) {
        throw new LiteError("LITE_TOOL_PACKAGE_HASH_MISMATCH", `file hash mismatch: ${file.path}`);
      }
    }
    if (totalBytes > this.maximumTotalBytes) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "package is too large");
    }
    for (const filePath of input.files.keys()) {
      if (!expectedPaths.has(filePath)) {
        throw new LiteError("LITE_TOOL_PACKAGE_INVALID", `unexpected package file: ${filePath}`);
      }
    }

    const capabilities = [...new Set(manifest.tools.map((tool) => tool.capability))];
    const warnings: string[] = [];
    if (capabilities.some((capability) => capability === "tool.install" || capability === "tool.delete")) {
      warnings.push("package requests user-only tool-management capabilities");
    }
    return {
      manifest,
      capabilities,
      warnings,
      fileCount: manifest.files.length,
      totalBytes,
      requiresAllowOnce: true,
    };
  }

  async install(input: {
    readonly manifestJson: string;
    readonly files: ReadonlyMap<string, Buffer>;
    readonly approval: "allow-once" | "deny";
  }): Promise<InstalledToolPackage> {
    if (input.approval !== "allow-once") {
      throw new LiteError("LITE_TOOL_PACKAGE_INSTALL_DENIED", "installation requires allow-once");
    }
    const preview = this.preview(input);
    const { manifest } = preview;
    assertSafePathSegment(manifest.packageId, "packageId");
    assertSafePathSegment(manifest.version, "version");
    const directory = path.join(this.paths.toolPackagesDirectory, manifest.packageId, manifest.version);
    await fs.mkdir(directory, { recursive: true });
    const installed: InstalledToolPackage = {
      schemaVersion: 1,
      packageId: manifest.packageId,
      version: manifest.version,
      installedAtIso: this.now().toISOString(),
      isEnabled: false,
      isBuiltIn: manifest.isBuiltIn === true,
      packageHash: manifest.packageHash,
      capabilities: preview.capabilities,
      directory,
    };
    await writeJsonAtomic(
      path.join(directory, "manifest.json"),
      path.join(directory, "manifest.json.bak"),
      manifest,
    );
    for (const file of manifest.files) {
      validateArchivePath(file.path);
      const target = path.join(directory, "files", ...file.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.files.get(file.path) ?? Buffer.alloc(0));
    }
    await writeJsonAtomic(
      path.join(directory, "install.json"),
      path.join(directory, "install.json.bak"),
      installed,
    );
    await this.bumpRevision();
    return installed;
  }

  async listInstalled(): Promise<readonly InstalledToolPackage[]> {
    let packageDirectories: string[];
    try {
      packageDirectories = await fs.readdir(this.paths.toolPackagesDirectory);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return [];
      throw error;
    }
    const installed: InstalledToolPackage[] = [];
    for (const packageId of packageDirectories) {
      const packageDirectory = path.join(this.paths.toolPackagesDirectory, packageId);
      const versions = await fs.readdir(packageDirectory).catch(() => [] as string[]);
      for (const version of versions) {
        const record = await this.readInstallRecord(packageId, version).catch(() => null);
        if (record !== null) installed.push(record);
      }
    }
    return installed.sort((left, right) =>
      `${left.packageId}@${left.version}`.localeCompare(`${right.packageId}@${right.version}`),
    );
  }

  async setEnabled(
    packageId: string,
    version: string,
    isEnabled: boolean,
  ): Promise<InstalledToolPackage> {
    const installed = await this.requireInstallRecord(packageId, version);
    const updated: InstalledToolPackage = { ...installed, isEnabled };
    const directory = path.join(this.paths.toolPackagesDirectory, packageId, version);
    await writeJsonAtomic(
      path.join(directory, "install.json"),
      path.join(directory, "install.json.bak"),
      updated,
    );
    await this.bumpRevision();
    return updated;
  }

  async delete(
    packageId: string,
    version: string,
    options: { readonly backup?: boolean } = {},
  ): Promise<void> {
    const installed = await this.requireInstallRecord(packageId, version);
    if (installed.isBuiltIn) {
      throw new LiteError("LITE_TOOL_PACKAGE_INSTALL_DENIED", "built-in packages cannot be deleted");
    }
    const directory = path.join(this.paths.toolPackagesDirectory, packageId, version);
    if (options.backup !== false) {
      const backupDirectory = path.join(
        this.paths.backupsDirectory,
        "tool-packages",
        packageId,
        `${version}-${this.now().getTime()}`,
      );
      try {
        await fs.mkdir(path.dirname(backupDirectory), { recursive: true });
        await fs.cp(directory, backupDirectory, { recursive: true });
      } catch {
        throw new LiteError("LITE_BACKUP_FAILED", "could not back up the tool package");
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
    await this.bumpRevision();
  }

  async getToolsetRevision(): Promise<number> {
    const result = await readJsonWithBackup<LifecycleFile>(
      path.join(this.paths.toolPackagesDirectory, "lifecycle.json"),
      path.join(this.paths.toolPackagesDirectory, "lifecycle.json.bak"),
    );
    return result?.value.revision ?? 1;
  }

  async getEnabledToolDefinitions(): Promise<readonly LiteToolDefinition[]> {
    const installed = await this.listInstalled();
    const definitions: LiteToolDefinition[] = [];
    const seen = new Set<string>();
    for (const record of installed) {
      if (!record.isEnabled) continue;
      const directory = path.join(this.paths.toolPackagesDirectory, record.packageId, record.version);
      const manifestResult = await readJsonWithBackup<ToolPackageManifest>(
        path.join(directory, "manifest.json"),
        path.join(directory, "manifest.json.bak"),
      );
      if (manifestResult === null) continue;
      for (const tool of manifestResult.value.tools) {
        if (seen.has(tool.name)) {
          throw new LiteError("LITE_TOOL_PACKAGE_INVALID", `duplicate enabled tool: ${tool.name}`);
        }
        seen.add(tool.name);
        definitions.push({
          name: tool.name,
          summary: tool.summary,
          inputSchema: tool.inputSchema,
          category: "installed",
        });
      }
    }
    return definitions.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async requireInstallRecord(
    packageId: string,
    version: string,
  ): Promise<InstalledToolPackage> {
    assertSafePathSegment(packageId, "packageId");
    assertSafePathSegment(version, "version");
    const record = await this.readInstallRecord(packageId, version);
    if (record === null) {
      throw new LiteError("LITE_TOOL_PACKAGE_INVALID", "tool package is not installed");
    }
    return record;
  }

  private async readInstallRecord(
    packageId: string,
    version: string,
  ): Promise<InstalledToolPackage | null> {
    assertSafePathSegment(packageId, "packageId");
    assertSafePathSegment(version, "version");
    const directory = path.join(this.paths.toolPackagesDirectory, packageId, version);
    const result = await readJsonWithBackup<InstalledToolPackage>(
      path.join(directory, "install.json"),
      path.join(directory, "install.json.bak"),
    );
    return result?.value ?? null;
  }

  private async bumpRevision(): Promise<number> {
    const current = await this.getToolsetRevision();
    const next = current + 1;
    await fs.mkdir(this.paths.toolPackagesDirectory, { recursive: true });
    await writeJsonAtomic(
      path.join(this.paths.toolPackagesDirectory, "lifecycle.json"),
      path.join(this.paths.toolPackagesDirectory, "lifecycle.json.bak"),
      {
        schemaVersion: 1,
        revision: next,
        updatedAtIso: this.now().toISOString(),
      } satisfies LifecycleFile,
    );
    return next;
  }
}
