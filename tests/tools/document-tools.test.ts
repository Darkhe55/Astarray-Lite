import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerDocumentTools } from "../../src/tools/builtin/document-tools.js";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

describe("document tools", () => {
  it("writes and reads UTF-8 documents", async () => {
    const workspace = await createTestDirectory("document-tools");
    directories.push(workspace);
    const registry = new ToolRegistry();
    registerDocumentTools(registry, { workspaceRoot: workspace });
    const executor = new ToolExecutor({ registry });

    const written = await executor.execute({
      callId: "c1",
      toolName: "write_document",
      argumentsJson: JSON.stringify({ path: "notes/readme.md", content: "# Title\n" }),
    });
    expect(written.ok).toBe(true);
    const read = await executor.execute({
      callId: "c2",
      toolName: "read_document",
      argumentsJson: JSON.stringify({ path: "notes/readme.md" }),
    });
    expect(read.ok).toBe(true);
    expect(JSON.parse(read.outputText)).toMatchObject({
      path: "notes/readme.md",
      extension: ".md",
      text: "# Title\n",
    });
    expect(await fs.readFile(path.join(workspace, "notes", "readme.md"), "utf8")).toBe("# Title\n");
  });

  it("reports missing office adapters explicitly", async () => {
    const workspace = await createTestDirectory("document-tools-office");
    directories.push(workspace);
    const registry = new ToolRegistry();
    registerDocumentTools(registry, { workspaceRoot: workspace });
    const result = await new ToolExecutor({ registry }).execute({
      callId: "c1",
      toolName: "read_document",
      argumentsJson: JSON.stringify({ path: "report.docx" }),
    });
    expect(result.errorCode).toBe("LITE_DOCUMENT_ADAPTER_MISSING");
  });

  it("uses a configured document adapter for office files", async () => {
    const workspace = await createTestDirectory("document-tools-adapter");
    directories.push(workspace);
    await fs.writeFile(path.join(workspace, "report.docx"), Buffer.from("docx"));
    const registry = new ToolRegistry();
    registerDocumentTools(registry, {
      workspaceRoot: workspace,
      adapter: {
        extensions: [".docx"],
        read: async ({ extension }) => `converted ${extension}`,
      },
    });
    const result = await new ToolExecutor({ registry }).execute({
      callId: "c1",
      toolName: "read_document",
      argumentsJson: JSON.stringify({ path: "report.docx" }),
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.outputText)).toMatchObject({
      adapter: "command",
      text: "converted .docx",
    });
  });
});
