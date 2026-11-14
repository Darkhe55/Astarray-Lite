import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../../contracts/errors.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { LiteToolHandlerResult, LiteToolSpec } from "../tool-types.js";
import { FileBackupStore } from "./backup-store.js";
import { assertNotSensitivePath, assertNotStatePath, resolveWorkspacePath } from "./path-safety.js";

const DEFAULT_MAXIMUM_READ_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_WRITE_BYTES = 1024 * 1024;
const DEFAULT_READ_LIMIT_LINES = 400;
const MAXIMUM_READ_LIMIT_LINES = 2_000;
const MAXIMUM_DIRECTORY_ENTRIES = 1_000;

export interface FileToolOptions {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly maximumReadBytes?: number;
  readonly maximumWriteBytes?: number;
  readonly now?: () => Date;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", `${key} must be a string`);
  }
  return value;
}

function optionalInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", `${key} must be an integer`);
  }
  return value;
}

async function readTextFile(input: {
  readonly workspaceRoot: string;
  readonly stateRoot: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
}): Promise<{ readonly absolutePath: string; readonly text: string; readonly sizeBytes: number }> {
  const absolutePath = await resolveWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    relativePath: input.relativePath,
  });
  assertNotSensitivePath(absolutePath);
  assertNotStatePath(absolutePath, input.stateRoot);

  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch {
    throw new LiteError("LITE_FILE_NOT_FOUND", "file not found");
  }
  if (stat.isSymbolicLink()) {
    throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "symbolic links are not readable");
  }
  if (!stat.isFile()) {
    throw new LiteError("LITE_FILE_NOT_FOUND", "path is not a regular file");
  }
  if (stat.size > input.maximumBytes) {
    throw new LiteError("LITE_FILE_TOO_LARGE", "file exceeds the read limit");
  }

  const buffer = await fs.readFile(absolutePath);
  if (buffer.includes(0)) {
    throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "binary files are not supported");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "file is not valid UTF-8 text");
  }
  return { absolutePath, text, sizeBytes: stat.size };
}

async function writeFileAtomic(absolutePath: string, content: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, absolutePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buildReadFileTool(options: Required<FileToolOptions>): LiteToolSpec {
  return {
    name: "read_file",
    capability: "fs.read",
    summary: "Read a workspace text file with line numbers and pagination.",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: true,
    requiresBackup: false,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: MAXIMUM_READ_LIMIT_LINES },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const relativePath = requiredString(record, "path");
      const offset = optionalInteger(record, "offset") ?? 1;
      const limit = Math.min(optionalInteger(record, "limit") ?? DEFAULT_READ_LIMIT_LINES, MAXIMUM_READ_LIMIT_LINES);
      const file = await readTextFile({
        workspaceRoot: options.workspaceRoot,
        stateRoot: options.stateRoot,
        relativePath,
        maximumBytes: options.maximumReadBytes,
      });
      const lines = file.text.split(/\r?\n/u);
      const startIndex = Math.max(0, offset - 1);
      const selected = lines.slice(startIndex, startIndex + limit);
      const formatted = selected
        .map((line, index) => `${String(startIndex + index + 1).padStart(6, " ")} | ${line}`)
        .join("\n");
      return { outputText: formatted };
    },
  };
}

function buildListDirectoryTool(options: Required<FileToolOptions>): LiteToolSpec {
  return {
    name: "list_directory",
    capability: "fs.read",
    summary: "List one directory level inside the workspace.",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: true,
    requiresBackup: false,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const relativePath = optionalString(record, "path") ?? ".";
      const absolutePath = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath,
      });
      assertNotSensitivePath(absolutePath);
      assertNotStatePath(absolutePath, options.stateRoot);
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch {
        throw new LiteError("LITE_FILE_NOT_FOUND", "directory not found");
      }
      if (!stat.isDirectory()) {
        throw new LiteError("LITE_FILE_NOT_FOUND", "path is not a directory");
      }

      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      const sorted = entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAXIMUM_DIRECTORY_ENTRIES);
      const output = sorted
        .map((entry) => `${entry.type === "directory" ? "d" : entry.type === "file" ? "f" : "?"} ${entry.name}`)
        .join("\n");
      return { outputText: output };
    },
  };
}

function buildWriteFileTool(options: Required<FileToolOptions>, backupStore: FileBackupStore): LiteToolSpec {
  return {
    name: "write_file",
    capability: "fs.write",
    summary: "Create or overwrite a workspace text file atomically, with a pre-image backup.",
    category: "basic",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
        createParents: { type: "boolean" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const relativePath = requiredString(record, "path");
      const content = typeof record["content"] === "string" ? record["content"] : "";
      const createParents = record["createParents"] !== false;
      if (Buffer.byteLength(content, "utf8") > options.maximumWriteBytes) {
        throw new LiteError("LITE_FILE_TOO_LARGE", "content exceeds the write limit");
      }

      const absolutePath = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath,
      });
      assertNotSensitivePath(absolutePath);
      assertNotStatePath(absolutePath, options.stateRoot);

      let backupId: string | undefined;
      let existing = false;
      try {
        const stat = await fs.lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "symbolic links are not writable");
        }
        if (!stat.isFile()) {
          throw new LiteError("LITE_FILE_NOT_FOUND", "path is not a regular file");
        }
        existing = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT")) {
          if (error instanceof LiteError) throw error;
          throw new LiteError("LITE_FILE_NOT_FOUND", "could not inspect the target file");
        }
      }

      if (existing) {
        const backup = await backupStore.backupExistingFile({ absolutePath, relativePath });
        backupId = backup?.backupId;
      }
      if (createParents) {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      }
      await writeFileAtomic(absolutePath, content);
      return {
        outputText: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${relativePath}${
          backupId === undefined ? "" : ` (backup ${backupId})`
        }`,
      };
    },
  };
}

function buildReplaceInFileTool(options: Required<FileToolOptions>, backupStore: FileBackupStore): LiteToolSpec {
  return {
    name: "replace_in_file",
    capability: "fs.write",
    summary: "Replace exact text in a workspace file, with a pre-image backup.",
    category: "basic",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
        expectedReplacements: { type: "integer", minimum: 1 },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const relativePath = requiredString(record, "path");
      const oldText = requiredString(record, "oldText");
      const newText = typeof record["newText"] === "string" ? record["newText"] : "";
      const replaceAll = record["replaceAll"] !== false;
      const expected = optionalInteger(record, "expectedReplacements");
      const file = await readTextFile({
        workspaceRoot: options.workspaceRoot,
        stateRoot: options.stateRoot,
        relativePath,
        maximumBytes: options.maximumReadBytes,
      });

      const occurrences = file.text.split(oldText).length - 1;
      if (occurrences === 0) {
        throw new LiteError("LITE_REPLACE_COUNT_MISMATCH", "oldText was not found");
      }
      if (expected !== undefined && occurrences !== expected) {
        throw new LiteError("LITE_REPLACE_COUNT_MISMATCH", "replacement count did not match", {
          expected,
          actual: occurrences,
        });
      }

      const updated = replaceAll
        ? file.text.split(oldText).join(newText)
        : file.text.replace(oldText, newText);
      const backup = await backupStore.backupExistingFile({
        absolutePath: file.absolutePath,
        relativePath,
      });
      await writeFileAtomic(file.absolutePath, updated);
      return {
        outputText: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${relativePath}${
          backup === null ? "" : ` (backup ${backup.backupId})`
        }`,
      };
    },
  };
}

export function registerFileTools(
  registry: ToolRegistry,
  options: FileToolOptions,
): void {
  const resolved: Required<FileToolOptions> = {
    workspaceRoot: options.workspaceRoot,
    stateRoot: options.stateRoot,
    maximumReadBytes: options.maximumReadBytes ?? DEFAULT_MAXIMUM_READ_BYTES,
    maximumWriteBytes: options.maximumWriteBytes ?? DEFAULT_MAXIMUM_WRITE_BYTES,
    now: options.now ?? (() => new Date()),
  };
  const backupStore = new FileBackupStore({
    stateRoot: resolved.stateRoot,
    now: resolved.now,
  });
  registry.register(buildReadFileTool(resolved));
  registry.register(buildListDirectoryTool(resolved));
  registry.register(buildWriteFileTool(resolved, backupStore));
  registry.register(buildReplaceInFileTool(resolved, backupStore));
}

