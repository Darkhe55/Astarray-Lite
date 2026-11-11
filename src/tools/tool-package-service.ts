import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import { canonicalJsonString } from "../context/canonical-json.js";
import { sha256Buffer, sha256Digest } from "../context/hash.js";
import { assertSafePathSegment, type LitePaths } from "../persistence/lite-paths.js";
import { writeJsonAtomic } from "../persistence/state-store.js";
import { isLiteCapabilityId, type LiteCapabilityId } from "../permissions/capabilities.js";

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
  readonly isEnabled: false;
  readonly packageHash: string;
  readonly capabilities: readonly LiteCapabilityId[];
  readonly directory: string;
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
    return installed;
  }
}
