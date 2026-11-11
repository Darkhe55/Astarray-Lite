import { createLiteApplication } from "../application/lite-application.js";
import { LiteError } from "../contracts/errors.js";

export interface CliResult {
  readonly exitCode: number;
  readonly output: string;
  readonly errorCode?: string;
}

export interface LiteCommandOptions {
  readonly cwd?: string;
  readonly sessionId?: string;
}

function parseOptions(argv: readonly string[]): {
  readonly command: string | undefined;
  readonly kernel: string;
  readonly json: boolean;
  readonly positionals: readonly string[];
  readonly idempotencyKey: string | undefined;
  readonly taskIdentifier: string | undefined;
} {
  let command: string | undefined;
  let kernel = "core";
  let json = false;
  let idempotencyKey: string | undefined;
  let taskIdentifier: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--kernel") {
      kernel = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--idempotency") {
      idempotencyKey = argv[index + 1];
      index += 1;
    } else if (argument === "--task-id") {
      taskIdentifier = argv[index + 1];
      index += 1;
    } else if (argument !== undefined && argument.startsWith("--")) {
      throw new LiteError("LITE_INVALID_ARGUMENT", `unknown option: ${argument}`);
    } else if (command === undefined) {
      command = argument;
    } else if (argument !== undefined) {
      positionals.push(argument);
    }
  }
  return { command, kernel, json, positionals, idempotencyKey, taskIdentifier };
}

function exitCodeFor(code: string | undefined): number {
  if (code === undefined) return 0;
  if (code === "LITE_INVALID_ARGUMENT" || code === "LITE_USER_MESSAGE_EMPTY") return 2;
  if (code === "LITE_TASK_NOT_FOUND") return 3;
  if (code === "LITE_PERMISSION_DENIED" || code === "LITE_PERMISSION_TIMEOUT") return 4;
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

export async function runLiteCommand(
  argv: readonly string[],
  options: LiteCommandOptions = {},
): Promise<CliResult> {
  let parsed;
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
          ? JSON.stringify({ ok: true, kernel: "lite", command: "run", result })
          : `queued ${result.taskIdentifier} (${result.status})`,
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
