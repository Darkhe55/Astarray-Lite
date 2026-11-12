import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerImageEditTool } from "../../src/tools/builtin/image-edit-tool.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

function png(): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(1, 20);
  return buffer;
}

describe("image_edit", () => {
  it("writes the edited image to a new file", async () => {
    const workspace = await createTestDirectory("image-edit");
    directories.push(workspace);
    const source = png();
    await fs.writeFile(path.join(workspace, "pixel.png"), source);
    const registry = new ToolRegistry();
    registerImageEditTool(registry, {
      workspaceRoot: workspace,
      imageProvider: {
        edit: async () => ({ dataBase64: png().toString("base64"), mediaType: "image/png" }),
      },
    });
    const result = await new ToolExecutor({ registry }).execute({
      callId: "c1",
      toolName: "image_edit",
      argumentsJson: JSON.stringify({ path: "pixel.png", prompt: "make it blue" }),
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.outputText)).toMatchObject({ path: "pixel.png.edited.png" });
    const written = await fs.readFile(path.join(workspace, "pixel.png.edited.png"));
    expect(written.subarray(0, 8)).toEqual(source.subarray(0, 8));
  });
});
