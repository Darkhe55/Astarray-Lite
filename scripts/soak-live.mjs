import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createProductKernel } from "../dist/product/product-kernel.js";
import { OpenAiCompatibleProvider } from "../dist/runtime/openai-provider.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const seconds = Number.parseInt(argument("--seconds", "28800"), 10);
const intervalSeconds = Number.parseInt(argument("--interval", "300"), 10);
const fake = process.argv.includes("--fake");
if (!Number.isInteger(seconds) || seconds <= 0 || !Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
  throw new Error("--seconds and --interval must be positive integers");
}

let provider;
if (fake) {
  provider = {
    providerId: "soak-fake",
    modelIdentifier: "soak-fake",
    async complete() {
      return {
        kind: "text",
        text: "OK",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      };
    },
  };
} else {
  const apiKey = process.env.ASTRARRAY_LITE_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("ASTRARRAY_LITE_API_KEY is required unless --fake is used");
  }
  provider = new OpenAiCompatibleProvider({
    baseUrl:
      process.env.ASTRARRAY_LITE_BASE_URL ??
      "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    apiKey,
    modelIdentifier: process.env.ASTRARRAY_LITE_MODEL ?? "spark-x2.6",
    timeoutMilliseconds: 120_000,
  });
}

const workspaceArgument = argument("--workspace", "");
const workspace =
  workspaceArgument !== ""
    ? path.resolve(workspaceArgument)
    : path.join(process.cwd(), ".tmp", `astarray-lite-soak-live-${process.pid}`);
await mkdir(workspace, { recursive: true });
const kernel = await createProductKernel({
  workspaceRootPath: workspace,
  sessionId: "soak-live",
  projectIdentifier: "soak-live",
  provider,
  profile: "safe",
  recoverOnStart: false,
  maxOutputTokens: 256,
  approvalHandler: async () => "deny",
});
await kernel.start();

const deadline = Date.now() + seconds * 1000;
let turns = 0;
let failures = 0;
let consecutiveFailures = 0;
try {
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    try {
      await kernel.submitUserMessage({ text: "只回答：OK" });
      const result = await kernel.runOnce();
      if (result.outcome === "completed") {
        turns += 1;
        consecutiveFailures = 0;
      } else {
        failures += 1;
        consecutiveFailures += 1;
      }
      process.stdout.write(
        `${JSON.stringify({
          atIso: new Date().toISOString(),
          turns,
          failures,
          outcome: result.outcome,
          textLength: result.text.length,
        })}\n`,
      );
    } catch (error) {
      failures += 1;
      consecutiveFailures += 1;
      process.stderr.write(
        `${JSON.stringify({
          atIso: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
    if (consecutiveFailures >= 5) {
      process.stderr.write("five consecutive failures; stopping soak\n");
      process.exitCode = 1;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wait = Math.min(intervalSeconds * 1000, remaining);
    const elapsed = Date.now() - startedAt;
    if (elapsed < wait) await new Promise((resolve) => setTimeout(resolve, wait - elapsed));
  }

  const snapshot = await kernel.getSnapshot();
  const diagnostics = await kernel.exportDiagnostics(path.join(workspace, "diagnostics.json"));
  process.stdout.write(
    `${JSON.stringify({
      finishedAtIso: new Date().toISOString(),
      seconds,
      intervalSeconds,
      fake,
      turns,
      failures,
      status: snapshot.status,
      counters: diagnostics.metrics.counters,
    })}\n`,
  );
} finally {
  await kernel.stop();
  await rm(workspace, { recursive: true, force: true });
}
