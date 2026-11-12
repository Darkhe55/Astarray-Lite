import { promises as fs } from "node:fs";

import { LiteError } from "../../contracts/errors.js";
import { sha256Buffer } from "../../context/hash.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "./path-safety.js";
import type { ToolRegistry } from "../tool-registry.js";

export interface ReadImageResult {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly contentHash: string;
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "\x89PNG\r\n\x1a\n": "image/png",
  "\xff\xd8\xff": "image/jpeg",
  GIF87a: "image/gif",
  GIF89a: "image/gif",
  RIFF: "image/webp",
};

export function detectImageType(buffer: Buffer): string | null {
  for (const [signature, mediaType] of Object.entries(IMAGE_TYPES)) {
    if (buffer.subarray(0, signature.length).toString("latin1") === signature) {
      return mediaType;
    }
  }
  return null;
}

export function readImageDimensions(
  buffer: Buffer,
  mediaType: string,
): { readonly width: number | null; readonly height: number | null } {
  if (mediaType === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mediaType === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mediaType === "image/webp" && buffer.length >= 30) {
    const chunk = buffer.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }
  if (mediaType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1] ?? 0;
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

export function registerImageTools(
  registry: ToolRegistry,
  options: { readonly workspaceRoot: string; readonly maximumBytes?: number },
): void {
  const maximumBytes = options.maximumBytes ?? 10 * 1024 * 1024;
  registry.register({
    name: "read_image",
    summary: "Read image metadata and dimensions from a workspace-relative path.",
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
      if (argumentsValue === null || typeof argumentsValue !== "object") {
        throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "arguments must be an object");
      }
      const relativePath = (argumentsValue as Record<string, unknown>)["path"];
      if (typeof relativePath !== "string") {
        throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "path must be a string");
      }
      assertNotSensitivePath(relativePath);
      const absolutePath = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath,
      });
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) throw new LiteError("LITE_INVALID_ARGUMENT", "path is not a file");
      if (stat.size > maximumBytes) {
        throw new LiteError("LITE_FILE_TOO_LARGE", "image is too large");
      }
      const buffer = await fs.readFile(absolutePath);
      const mediaType = detectImageType(buffer);
      if (mediaType === null) {
        throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "unsupported image format");
      }
      const dimensions = readImageDimensions(buffer, mediaType);
      const result: ReadImageResult = {
        path: relativePath,
        mediaType,
        sizeBytes: stat.size,
        width: dimensions.width,
        height: dimensions.height,
        contentHash: sha256Buffer(buffer),
      };
      return { outputText: JSON.stringify(result) };
    },
  });
}
