import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createProductKernel } from "../dist/product/product-kernel.js";

const secondsArg = process.argv.indexOf("--seconds");
const seconds = secondsArg >= 0 ? Number.parseInt(process.argv[secondsArg + 1] ?? "", 10) : 3600;
if (!Number.isInteger(seconds) || seconds <= 0) {
  throw new Error("--seconds must be a positive integer");
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "astarray-lite-soak-"));
const provider = {
  providerId: "soak",
  modelIdentifier: "soak-fake",
  complete: async () => ({
    kind: "text",
    text: "ok",
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  }),
};

const kernel = await createProductKernel({
  workspaceRootPath: workspace,
  sessionId: "soak",
  projectIdentifier: "soak",
  provider,
  recoverOnStart: false,
});
await kernel.start();
let turns = 0;
let failures = 0;
const deadline = Date.now() + seconds * 1000;
try {
  while (Date.now() < deadline) {
    await kernel.submitUserMessage({ text: `soak turn ${turns}` });
    const result = await kernel.runOnce();
    if (result.outcome === "completed") turns += 1;
    if (result.outcome === "error") failures += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = await kernel.getSnapshot();
  const diagnostics = await kernel.exportDiagnostics(path.join(workspace, "diagnostics.json"));
  process.stdout.write(
    `${JSON.stringify({
      seconds,
      turns,
      failures,
      status: snapshot.status,
      counters: diagnostics.metrics.counters,
    })}\n`,
  );
  if (failures > 0) process.exitCode = 1;
} finally {
  await kernel.stop();
  await rm(workspace, { recursive: true, force: true });
}
