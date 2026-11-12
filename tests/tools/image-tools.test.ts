import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerImageTools } from "../../src/tools/builtin/image-tools.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("read_image", () => {
  it("returns format and dimensions", async () => {
    const workspace = await createTestDirectory("image-tools");
    directories.push(workspace);
    await fs.writeFile(path.join(workspace, "pixel.png"), png(320, 200));
    const registry = new ToolRegistry();
    registerImageTools(registry, { workspaceRoot: workspace });
    const result = await new ToolExecutor({ registry }).execute({
      callId: "c1",
      toolName: "read_image",
      argumentsJson: JSON.stringify({ path: "pixel.png" }),
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.outputText)).toMatchObject({
      mediaType: "image/png",
      width: 320,
      height: 200,
    });
  });

  it("rejects non-images and sensitive paths", async () => {
    const workspace = await createTestDirectory("image-tools-errors");
    directories.push(workspace);
    await fs.writeFile(path.join(workspace, "notes.txt"), "hello");
    await fs.writeFile(path.join(workspace, ".env"), "X=1");
    const registry = new ToolRegistry();
    registerImageTools(registry, { workspaceRoot: workspace });
    const executor = new ToolExecutor({ registry });
    const text = await executor.execute({
      callId: "c1",
      toolName: "read_image",
      argumentsJson: JSON.stringify({ path: "notes.txt" }),
    });
    expect(text.errorCode).toBe("LITE_FILE_BINARY_UNSUPPORTED");
    const sensitive = await executor.execute({
      callId: "c2",
      toolName: "read_image",
      argumentsJson: JSON.stringify({ path: ".env" }),
    });
    expect(sensitive.errorCode).toBe("LITE_SENSITIVE_CONTENT_BLOCKED");
  });
});
