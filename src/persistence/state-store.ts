import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";

export type JsonReadSource = "primary" | "backup";

export interface JsonReadResult<T> {
  readonly value: T;
  readonly source: JsonReadSource;
}

const RENAME_RETRY_DELAYS_MILLISECONDS = [25, 50, 100, 200, 400, 800, 800] as const;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRetryableRenameError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MILLISECONDS.length; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error) || attempt === RENAME_RETRY_DELAYS_MILLISECONDS.length) {
        break;
      }
      await sleep(RENAME_RETRY_DELAYS_MILLISECONDS[attempt] ?? 800);
    }
  }
  throw lastError;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new LiteError("LITE_STATE_CORRUPT", `invalid JSON in ${path.basename(filePath)}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Reads a JSON state file, falling back to its `.bak` sibling.
 *
 * Returns null only when neither file exists. A corrupt primary with a valid
 * backup is recovered and reported as `source: "backup"`.
 */
export async function readJsonWithBackup<T>(
  filePath: string,
  backupPath: string,
): Promise<JsonReadResult<T> | null> {
  let primaryError: LiteError | null = null;
  try {
    const value = await readJsonFile<T>(filePath);
    if (value !== null) return { value, source: "primary" };
  } catch (error) {
    if (!(error instanceof LiteError)) throw error;
    primaryError = error;
  }

  try {
    const backup = await readJsonFile<T>(backupPath);
    if (backup !== null) return { value: backup, source: "backup" };
  } catch (error) {
    if (!(error instanceof LiteError)) throw error;
    throw new LiteError("LITE_STATE_CORRUPT", "state file and backup are unreadable", {
      primary: primaryError?.message ?? null,
      backup: error.message,
    });
  }

  if (primaryError !== null) {
    throw new LiteError("LITE_STATE_CORRUPT", "state file is corrupt and no backup exists", {
      primary: primaryError.message,
    });
  }
  return null;
}

export interface WriteJsonAtomicOptions {
  /**
   * Runs after the temp file is durable and immediately before the rename.
   * Throwing aborts the commit and leaves the target untouched.
   */
  readonly beforeCommit?: () => Promise<void>;
}

/**
 * Writes JSON atomically: temp file -> fsync -> backup current target -> rename.
 *
 * The backup is written before the rename; if it fails, the target is left
 * untouched. This is the only write path for authoritative state files.
 */
export async function writeJsonAtomic(
  filePath: string,
  backupPath: string,
  value: unknown,
  options: WriteJsonAtomicOptions = {},
): Promise<void> {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "value is not JSON-serializable", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  const handle = await fs.open(temporaryPath, "wx");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    try {
      await fs.access(filePath);
      await fs.copyFile(filePath, backupPath);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
    if (options.beforeCommit !== undefined) {
      await options.beforeCommit();
    }
    await renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof LiteError) throw error;
    throw new LiteError("LITE_INTERNAL_ERROR", `failed to commit ${path.basename(filePath)}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
