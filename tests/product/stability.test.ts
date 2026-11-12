import { afterEach, describe, expect, it } from "vitest";

import { createProductKernel } from "../../src/product/product-kernel.js";
import { FakeProvider } from "../../src/runtime/fake-provider.js";
import { createTestDirectory, removeTestDirectory } from "../persistence/test-paths.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTestDirectory));
});

describe("product stability", () => {
  it("does not call the provider while idle and completes sequential turns", async () => {
    const workspace = await createTestDirectory("product-stability");
    directories.push(workspace);
    const provider = new FakeProvider(
      Array.from({ length: 5 }, (_, index) => ({ kind: "text" as const, text: `reply ${index}` })),
    );
    const kernel = await createProductKernel({
      workspaceRootPath: workspace,
      sessionId: "stability",
      projectIdentifier: "stability",
      provider,
    });
    await kernel.start();
    for (let index = 0; index < 20; index += 1) {
      expect(await kernel.runOnce()).toMatchObject({ outcome: "idle" });
    }
    expect(provider.requests).toHaveLength(0);

    for (let index = 0; index < 5; index += 1) {
      await kernel.submitUserMessage({ text: `turn ${index}` });
      const result = await kernel.runOnce();
      expect(result.outcome).toBe("completed");
    }
    expect((await kernel.getSnapshot()).activeUserMessageId).toBeNull();
    const diagnostics = await kernel.exportDiagnostics(`${workspace}/diag.json`);
    expect(diagnostics.metrics.counters["turns"]).toBe(5);
    await kernel.stop();
  });
});
