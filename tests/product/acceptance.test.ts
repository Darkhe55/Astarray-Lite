import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProductKernel } from "../../src/product/product-kernel.js";
import { FakeProvider } from "../../src/runtime/fake-provider.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

async function setup(responses: ConstructorParameters<typeof FakeProvider>[0]) {
  const workspace = await createTestDirectory("product-acceptance");
  directories.push(workspace);
  const provider = new FakeProvider(responses);
  const kernel = await createProductKernel({
    workspaceRootPath: workspace,
    sessionId: "acceptance",
    projectIdentifier: "acceptance",
    provider,
    approvalHandler: async () => "allow-session",
  });
  return { workspace, provider, kernel };
}

describe("product acceptance", () => {
  it("completes a coding task with write, replace and diagnostics", async () => {
    const { workspace, kernel } = await setup([
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "c1",
            toolName: "write_file",
            argumentsJson: JSON.stringify({ path: "src/value.ts", content: "export const value = 1;\n" }),
          },
        ],
      },
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "c2",
            toolName: "replace_in_file",
            argumentsJson: JSON.stringify({
              path: "src/value.ts",
              oldText: "value = 1",
              newText: "value = 2",
            }),
          },
        ],
      },
      { kind: "text", text: "implemented" },
    ]);
    await kernel.start();
    await kernel.submitUserMessage({ text: "create and update a source file" });
    const result = await kernel.runOnce();
    expect(result.outcome).toBe("completed");
    expect(result.toolCallCount).toBe(2);
    expect(await fs.readFile(path.join(workspace, "src", "value.ts"), "utf8")).toContain("value = 2");
    expect(await kernel.listBackups()).not.toHaveLength(0);
    const diagnostics = await kernel.exportDiagnostics(path.join(workspace, "diag.json"));
    expect(diagnostics.metrics.counters.turns).toBe(1);
    await kernel.stop();
  });

  it("rewrites a markdown document and reads it back", async () => {
    const { workspace, provider, kernel } = await setup([
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "c1",
            toolName: "write_document",
            argumentsJson: JSON.stringify({ path: "docs/notes.md", content: "# Updated\n" }),
          },
        ],
      },
      {
        kind: "tool-calls",
        calls: [
          {
            callId: "c2",
            toolName: "read_document",
            argumentsJson: JSON.stringify({ path: "docs/notes.md" }),
          },
        ],
      },
      { kind: "text", text: "document updated" },
    ]);
    await kernel.start();
    await kernel.submitUserMessage({ text: "rewrite the notes" });
    await kernel.runOnce();
    expect(await fs.readFile(path.join(workspace, "docs", "notes.md"), "utf8")).toBe("# Updated\n");
    const toolMessages = provider.requests.at(-1)?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages.at(-1)?.content).toContain("# Updated");
    await kernel.stop();
  });

  it("sends attached images as multimodal content", async () => {
    const { workspace, provider, kernel } = await setup([{ kind: "text", text: "image seen" }]);
    const image = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image, 0);
    await fs.writeFile(path.join(workspace, "photo.png"), image);
    await kernel.start();
    await kernel.submitUserMessage({
      text: "describe the image",
      attachments: [{ path: "photo.png", mediaType: "image/png", sizeBytes: 24 }],
    });
    await kernel.runOnce();
    expect(provider.requests[0]?.messages[1]?.contentParts).toHaveLength(2);
    await kernel.stop();
  });
});
