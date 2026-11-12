import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../../contracts/errors.js";
import type { DocumentAdapter } from "./document-adapters.js";
import { extractDocxText } from "./docx-text.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "./path-safety.js";
import type { ToolRegistry } from "../tool-registry.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".log",
  ".html",
  ".css",
  ".ts",
  ".js",
]);

const CONVERTER_EXTENSIONS = new Set([".docx", ".pdf", ".pptx", ".xlsx", ".odt"]);

function extensionOf(relativePath: string): string {
  return path.extname(relativePath).toLowerCase();
}

function asPath(argumentsValue: unknown): string {
  if (argumentsValue === null || typeof argumentsValue !== "object") {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "arguments must be an object");
  }
  const value = (argumentsValue as Record<string, unknown>)["path"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "path must be a non-empty string");
  }
  return value;
}

export function registerDocumentTools(
  registry: ToolRegistry,
  options: {
    readonly workspaceRoot: string;
    readonly maximumBytes?: number;
    readonly adapter?: DocumentAdapter;
  },
): void {
  const maximumBytes = options.maximumBytes ?? 2 * 1024 * 1024;

  registry.register({
    name: "read_document",
    summary: "Read a UTF-8 text document; office formats require an optional adapter.",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: true,
    requiresBackup: false,
    capability: "fs.read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (argumentsValue) => {
      const relativePath = asPath(argumentsValue);
      assertNotSensitivePath(relativePath);
      const extension = extensionOf(relativePath);
      if (extension === ".docx") {
        const absolutePath = await resolveWorkspacePath({
          workspaceRoot: options.workspaceRoot,
          relativePath,
        });
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) throw new LiteError("LITE_INVALID_ARGUMENT", "path is not a file");
        if (stat.size > maximumBytes) {
          throw new LiteError("LITE_FILE_TOO_LARGE", "document is too large");
        }
        const text = extractDocxText(await fs.readFile(absolutePath));
        return {
          outputText: JSON.stringify({
            path: relativePath,
            extension,
            sizeBytes: stat.size,
            adapter: "builtin-docx",
            text,
          }),
        };
      }
      if (CONVERTER_EXTENSIONS.has(extension)) {
        const adapter = options.adapter;
        if (adapter === undefined || !adapter.extensions.includes(extension)) {
          throw new LiteError(
            "LITE_DOCUMENT_ADAPTER_MISSING",
            `no document adapter is installed for ${extension}`,
          );
        }
        const absolutePath = await resolveWorkspacePath({
          workspaceRoot: options.workspaceRoot,
          relativePath,
        });
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) throw new LiteError("LITE_INVALID_ARGUMENT", "path is not a file");
        if (stat.size > maximumBytes) {
          throw new LiteError("LITE_FILE_TOO_LARGE", "document is too large");
        }
        const text = await adapter.read({ absolutePath, extension });
        return {
          outputText: JSON.stringify({
            path: relativePath,
            extension,
            sizeBytes: stat.size,
            adapter: "command",
            text,
          }),
        };
      }
      if (!TEXT_EXTENSIONS.has(extension)) {
        throw new LiteError(
          "LITE_FILE_BINARY_UNSUPPORTED",
          `unsupported document extension: ${extension || "(none)"}`,
        );
      }
      const absolutePath = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath,
      });
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) throw new LiteError("LITE_INVALID_ARGUMENT", "path is not a file");
      if (stat.size > maximumBytes) {
        throw new LiteError("LITE_FILE_TOO_LARGE", "document is too large");
      }
      const text = await fs.readFile(absolutePath, "utf8");
      return {
        outputText: JSON.stringify({
          path: relativePath,
          extension,
          sizeBytes: stat.size,
          text,
        }),
      };
    },
  });

  registry.register({
    name: "write_document",
    summary: "Write a UTF-8 text document atomically.",
    category: "basic",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: true,
    capability: "fs.write",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (argumentsValue) => {
      const relativePath = asPath(argumentsValue);
      assertNotSensitivePath(relativePath);
      const extension = extensionOf(relativePath);
      if (CONVERTER_EXTENSIONS.has(extension)) {
        throw new LiteError(
          "LITE_DOCUMENT_ADAPTER_MISSING",
          `no document adapter is installed for ${extension}`,
        );
      }
      if (!TEXT_EXTENSIONS.has(extension)) {
        throw new LiteError(
          "LITE_FILE_BINARY_UNSUPPORTED",
          `unsupported document extension: ${extension || "(none)"}`,
        );
      }
      const content = (argumentsValue as Record<string, unknown>)["content"];
      if (typeof content !== "string") {
        throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "content must be a string");
      }
      if (Buffer.byteLength(content, "utf8") > maximumBytes) {
        throw new LiteError("LITE_FILE_TOO_LARGE", "document is too large");
      }
      const absolutePath = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath,
      });
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const temporary = `${absolutePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, content, "utf8");
        await fs.rename(temporary, absolutePath);
      } catch (error) {
        await fs.rm(temporary, { force: true });
        if (error instanceof LiteError) throw error;
        throw new LiteError("LITE_TOOL_EXECUTION_FAILED", "could not write document");
      }
      return {
        outputText: JSON.stringify({
          path: relativePath,
          extension,
          sizeBytes: Buffer.byteLength(content, "utf8"),
        }),
      };
    },
  });
}
