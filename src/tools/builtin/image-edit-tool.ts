import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../../contracts/errors.js";
import type { ImageEditResult } from "../../runtime/image-provider.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "./path-safety.js";
import { detectImageType } from "./image-tools.js";
import type { ToolRegistry } from "../tool-registry.js";

export interface ImageEditProvider {
  edit(request: {
    readonly imageBase64: string;
    readonly mediaType: string;
    readonly prompt: string;
    readonly size?: "256x256" | "512x512" | "1024x1024" | "1536x1024" | "1024x1536";
  }): Promise<ImageEditResult>;
}

export function registerImageEditTool(
  registry: ToolRegistry,
  options: {
    readonly workspaceRoot: string;
    readonly imageProvider: ImageEditProvider;
    readonly maximumBytes?: number;
  },
): void {
  const maximumBytes = options.maximumBytes ?? 10 * 1024 * 1024;
  registry.register({
    name: "image_edit",
    summary: "Edit an image with the configured image model and write a new file.",
    category: "basic",
    toolClass: "restricted",
    isIdempotent: false,
    requiresBackup: true,
    capability: "fs.write",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        outputPath: { type: "string", minLength: 1 },
        size: {
          type: "string",
          enum: ["256x256", "512x512", "1024x1024", "1536x1024", "1024x1536"],
        },
      },
      required: ["path", "prompt"],
      additionalProperties: false,
    },
    handler: async (argumentsValue) => {
      if (argumentsValue === null || typeof argumentsValue !== "object") {
        throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "arguments must be an object");
      }
      const args = argumentsValue as Record<string, unknown>;
      const inputPath = args["path"];
      const prompt = args["prompt"];
      if (typeof inputPath !== "string" || typeof prompt !== "string" || prompt.trim() === "") {
        throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "path and prompt are required");
      }
      assertNotSensitivePath(inputPath);
      const absoluteInput = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath: inputPath,
      });
      const stat = await fs.stat(absoluteInput);
      if (!stat.isFile()) throw new LiteError("LITE_INVALID_ARGUMENT", "path is not a file");
      if (stat.size > maximumBytes) throw new LiteError("LITE_FILE_TOO_LARGE", "image is too large");
      const input = await fs.readFile(absoluteInput);
      const mediaType = detectImageType(input);
      if (mediaType === null) {
        throw new LiteError("LITE_FILE_BINARY_UNSUPPORTED", "unsupported image format");
      }
      const outputRelative =
        typeof args["outputPath"] === "string" && args["outputPath"] !== ""
          ? args["outputPath"]
          : `${inputPath}.edited.png`;
      assertNotSensitivePath(outputRelative);
      const outputAbsolute = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        relativePath: outputRelative,
      });

      const edited = await options.imageProvider.edit({
        imageBase64: input.toString("base64"),
        mediaType,
        prompt,
        ...(typeof args["size"] === "string"
          ? {
              size: args["size"] as
                | "256x256"
                | "512x512"
                | "1024x1024"
                | "1536x1024"
                | "1024x1536",
            }
          : {}),
      });
      const bytes = Buffer.from(edited.dataBase64, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
        throw new LiteError("LITE_IMAGE_PROVIDER_FAILED", "edited image size is invalid");
      }
      await fs.mkdir(path.dirname(outputAbsolute), { recursive: true });
      const temporary = `${outputAbsolute}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes);
        await fs.rename(temporary, outputAbsolute);
      } catch {
        await fs.rm(temporary, { force: true });
        throw new LiteError("LITE_TOOL_EXECUTION_FAILED", "could not write edited image");
      }
      return {
        outputText: JSON.stringify({
          path: outputRelative,
          mediaType: edited.mediaType,
          sizeBytes: bytes.byteLength,
          ...(edited.revisedPrompt === undefined ? {} : { revisedPrompt: edited.revisedPrompt }),
        }),
      };
    },
  });
}
