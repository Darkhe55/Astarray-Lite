import { LiteError } from "../../contracts/errors.js";

const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s"'`=;|&<>])\.astarray-lite(?:[\s"'`/\\;|&<>]|$)/iu,
  /(?:^|[\s"'`=;|&<>])state\.json(?:[\s"'`;|&<>]|$)/iu,
  /(?:^|[\s"'`=;|&<>])sequence\.json(?:[\s"'`;|&<>]|$)/iu,
  /(?:^|[\s"'`=;|&<>])backups(?:[\s"'`/\\;|&<>]|$)/iu,
  /(?:^|[\s"'`=;|&<>])locks(?:[\s"'`/\\;|&<>]|$)/iu,
];

const BASE_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

const SENSITIVE_ENVIRONMENT_PATTERN =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|ASTRARRAY|STATE)/iu;

export function assertShellCommandAllowed(command: string): void {
  if (command.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "shell command must be non-empty");
  }
  if (command.includes("\0")) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "shell command contains a NUL byte");
  }
  if (command.length > 8_000) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "shell command is too long");
  }
  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(command)) {
      throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "shell command references kernel state");
    }
  }
}

export function normalizeShellCommandForAudit(command: string): string {
  const normalized = command.replace(/\s+/gu, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}[truncated]`;
}

export function buildShellEnvironment(
  requestedNames: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of BASE_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of requestedNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "environment variable name is invalid");
    }
    if (SENSITIVE_ENVIRONMENT_PATTERN.test(name)) {
      throw new LiteError("LITE_SENSITIVE_CONTENT_BLOCKED", "sensitive environment variables cannot be passed");
    }
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
