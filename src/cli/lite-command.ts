import { createLiteApplication } from "../application/lite-application.js";
import { LiteError } from "../contracts/errors.js";
import { LITE_PACKAGE_VERSION } from "../contracts/package-version.js";
import type { LiteProvider } from "../runtime/provider.js";
import { OpenAiCompatibleProvider } from "../runtime/openai-provider.js";
import { OpenAiImageProvider } from "../runtime/image-provider.js";
import { createProductKernel } from "../product/product-kernel.js";
import { resolveLitePaths } from "../persistence/lite-paths.js";
import { readJsonWithBackup } from "../persistence/state-store.js";
import { TaskSequenceStore } from "../tasks/task-sequence-store.js";
import { LiteMetrics } from "../observability/metrics.js";
import { buildDiagnosticBundle, writeDiagnosticBundle } from "../observability/diagnostic-bundle.js";
import path from "node:path";

export interface CliResult {
  readonly exitCode: number;
  readonly output: string;
  readonly errorCode?: string;
}

export interface LiteCommandOptions {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly provider?: LiteProvider;
}

interface ParsedOptions {
  readonly command: string | undefined;
  readonly kernel: string;
  readonly json: boolean;
  readonly enqueue: boolean;
  readonly allowTools: boolean;
  readonly profile: "safe" | "balanced" | "trusted";
  readonly positionals: readonly string[];
  readonly idempotencyKey: string | undefined;
  readonly taskIdentifier: string | undefined;
  readonly outPath: string | undefined;
}

function parseOptions(argv: readonly string[]): ParsedOptions {
  let command: string | undefined;
  let kernel = "core";
  let json = false;
  let enqueue = false;
  let allowTools = false;
  let profile: "safe" | "balanced" | "trusted" = "balanced";
  let idempotencyKey: string | undefined;
  let taskIdentifier: string | undefined;
  let outPath: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--kernel") {
      kernel = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--enqueue") {
      enqueue = true;
    } else if (argument === "--yes") {
      allowTools = true;
    } else if (argument === "--profile") {
      const value = argv[index + 1];
      if (value !== "safe" && value !== "balanced" && value !== "trusted") {
        throw new LiteError("LITE_INVALID_ARGUMENT", "profile must be safe, balanced or trusted");
      }
      profile = value;
      index += 1;
    } else if (argument === "--idempotency") {
      idempotencyKey = argv[index + 1];
      index += 1;
    } else if (argument === "--task-id") {
      taskIdentifier = argv[index + 1];
      index += 1;
    } else if (argument === "--out") {
      outPath = argv[index + 1];
      index += 1;
    } else if (argument !== undefined && argument.startsWith("--")) {
      throw new LiteError("LITE_INVALID_ARGUMENT", `unknown option: ${argument}`);
    } else if (command === undefined) {
      command = argument;
    } else if (argument !== undefined) {
      positionals.push(argument);
    }
  }
  return { command, kernel, json, enqueue, allowTools, profile, positionals, idempotencyKey, taskIdentifier, outPath };
}

function exitCodeFor(code: string | undefined): number {
  if (code === undefined) return 0;
  if (code === "LITE_INVALID_ARGUMENT" || code === "LITE_USER_MESSAGE_EMPTY") return 2;
  if (code === "LITE_TASK_NOT_FOUND") return 3;
  if (
    code === "LITE_PERMISSION_DENIED" ||
    code === "LITE_PERMISSION_TIMEOUT" ||
    code === "LITE_PROVIDER_AUTH_FAILED"
  ) {
    return 4;
  }
  return 1;
}

function errorResult(error: unknown, json: boolean): CliResult {
  const code = error instanceof LiteError ? error.code : "LITE_INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  return {
    exitCode: exitCodeFor(code),
    output: json
      ? JSON.stringify({ ok: false, kernel: "lite", error: { code, message } })
      : `error: ${code}: ${message}`,
    errorCode: code,
  };
}

function providerFromEnvironment(): LiteProvider | undefined {
  const apiKey = process.env["ASTRARRAY_LITE_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") return undefined;
  return new OpenAiCompatibleProvider({
    baseUrl: process.env["ASTRARRAY_LITE_BASE_URL"] ?? "https://api.openai.com/v1",
    apiKey,
    modelIdentifier: process.env["ASTRARRAY_LITE_MODEL"] ?? "gpt-4.1-mini",
  });
}

function imageProviderFromEnvironment(): OpenAiImageProvider | undefined {
  const apiKey = process.env["ASTRARRAY_LITE_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") return undefined;
  return new OpenAiImageProvider({
    baseUrl: process.env["ASTRARRAY_LITE_BASE_URL"] ?? "https://api.openai.com/v1",
    apiKey,
    modelIdentifier: process.env["ASTRARRAY_LITE_IMAGE_MODEL"] ?? "gpt-image-1",
  });
}

export async function runLiteCommand(
  argv: readonly string[],
  options: LiteCommandOptions = {},
): Promise<CliResult> {
  let parsed: ParsedOptions;
  try {
    parsed = parseOptions(argv);
  } catch (error) {
    return errorResult(error, true);
  }

  if (parsed.kernel !== "lite") {
    return { exitCode: 0, output: "core kernel is not provided by the astarray-lite package" };
  }

  try {
    if (parsed.command === "run") {
      const prompt = parsed.positionals.join(" ");
      if (prompt.trim() === "") {
        throw new LiteError("LITE_USER_MESSAGE_EMPTY", "prompt must be non-empty");
      }

      if (parsed.enqueue) {
        const application = await createLiteApplication({
          kernel: "lite",
          stateDirectory: ".astarray-lite",
          workspaceRootPath: options.cwd ?? ".",
          sessionId: options.sessionId ?? "cli-session",
        });
        const result = await application.submitTask({
          sessionId: options.sessionId ?? "cli-session",
          taskIdentifier: parsed.taskIdentifier ?? "cli-task",
          prompt,
          ...(parsed.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: parsed.idempotencyKey }),
        });
        return {
          exitCode: 0,
          output: parsed.json
            ? JSON.stringify({ ok: true, kernel: "lite", command: "run", mode: "enqueue", result })
            : `queued ${result.taskIdentifier} (${result.status})`,
        };
      }

      const provider = options.provider ?? providerFromEnvironment();
      if (provider === undefined) {
        throw new LiteError(
          "LITE_PROVIDER_AUTH_FAILED",
          "set ASTRARRAY_LITE_API_KEY (and optionally ASTRARRAY_LITE_BASE_URL/ASTRARRAY_LITE_MODEL)",
        );
      }
      const imageProvider = imageProviderFromEnvironment();
      const kernel = await createProductKernel({
        workspaceRootPath: options.cwd ?? ".",
        sessionId: options.sessionId ?? "cli-session",
        projectIdentifier: "cli-project",
        provider,
        profile: parsed.profile,
        ...(imageProvider === undefined ? {} : { imageProvider }),
        approvalHandler: async () => (parsed.allowTools ? "allow-session" : "deny"),
      });
      await kernel.start();
      try {
        await kernel.submitUserMessage({ text: prompt });
        const result = await kernel.runOnce();
        if (result.outcome === "error") {
          throw new LiteError(
            (result.errorCode as LiteError["code"] | undefined) ?? "LITE_PROVIDER_REQUEST_FAILED",
            result.errorCode ?? "provider turn failed",
          );
        }
        return {
          exitCode: 0,
          output: parsed.json
            ? JSON.stringify({
                ok: true,
                kernel: "lite",
                command: "run",
                mode: "execute",
                outcome: result.outcome,
                text: result.text,
                toolCallCount: result.toolCallCount,
              })
            : result.text || `(${result.outcome})`,
        };
      } finally {
        await kernel.stop();
      }
    }
    if (parsed.command === "diagnostics") {
      const workspace = path.resolve(options.cwd ?? ".");
      const paths = resolveLitePaths({ stateDirectory: ".astarray-lite", workspaceRootPath: workspace });
      const state = await readJsonWithBackup<{ status?: string }>(
        paths.stateFile,
        paths.stateBackupFile,
      );
      const sequence = await new TaskSequenceStore(paths).read();
      const metrics = new LiteMetrics();
      metrics.setGauge("tasks.pending", sequence.pendingTaskIds.length);
      const bundle = buildDiagnosticBundle({
        packageVersion: LITE_PACKAGE_VERSION,
        kernelStatus: state?.value.status ?? "idle",
        metrics: metrics.snapshot(),
        recentEvents: [],
      });
      const outputPath = path.resolve(
        workspace,
        parsed.outPath ?? path.join(".astarray-lite", "diagnostics.json"),
      );
      await writeDiagnosticBundle(outputPath, bundle);
      return {
        exitCode: 0,
        output: parsed.json
          ? JSON.stringify({ ok: true, kernel: "lite", command: "diagnostics", path: outputPath })
          : outputPath,
      };
    }
    if (parsed.command === "goals") {
      return {
        exitCode: 0,
        output: parsed.json
          ? JSON.stringify({ ok: true, kernel: "lite", command: "goals", goals: [] })
          : "(no goals)",
      };
    }
    return errorResult(new LiteError("LITE_INVALID_ARGUMENT", "command must be run or goals"), parsed.json);
  } catch (error) {
    return errorResult(error, parsed.json);
  }
}

export async function runCommand(
  argv: readonly string[],
  options: LiteCommandOptions = {},
): Promise<CliResult> {
  let kernel = "core";
  const kernelIndex = argv.indexOf("--kernel");
  if (kernelIndex >= 0) kernel = argv[kernelIndex + 1] ?? "";
  if (kernel === "lite") return runLiteCommand(argv, options);
  return { exitCode: 0, output: "core kernel is not provided by the astarray-lite package" };
}
