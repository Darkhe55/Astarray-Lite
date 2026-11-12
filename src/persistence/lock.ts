import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import { LITE_PACKAGE_VERSION } from "../contracts/package-version.js";
import { writeJsonAtomic } from "./state-store.js";

export interface LiteLockRecord {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAtIso: string;
  readonly heartbeatAtIso: string;
  readonly kernelVersion: string;
}

export type LiteLockAcquireResult =
  | { readonly acquired: true; readonly record: LiteLockRecord; readonly wasStaleTakeover: boolean }
  | { readonly acquired: false; readonly holder: LiteLockRecord | null };

export interface LiteLockOptions {
  readonly lockFile: string;
  readonly staleAfterMilliseconds?: number;
  readonly kernelVersion?: string;
  readonly now?: () => Date;
}

const DEFAULT_STALE_AFTER_MILLISECONDS = 30_000;

function parseLockRecord(value: unknown): LiteLockRecord {
  if (value === null || typeof value !== "object") {
    throw new LiteError("LITE_STATE_CORRUPT", "lock file is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) {
    throw new LiteError("LITE_SCHEMA_UNSUPPORTED", "unsupported lock schema version");
  }
  if (typeof record["token"] !== "string" || record["token"] === "") {
    throw new LiteError("LITE_STATE_CORRUPT", "lock file is missing token");
  }
  if (
    typeof record["pid"] !== "number" ||
    !Number.isInteger(record["pid"]) ||
    record["pid"] <= 0
  ) {
    throw new LiteError("LITE_STATE_CORRUPT", "lock file is missing pid");
  }
  for (const field of ["hostname", "startedAtIso", "heartbeatAtIso", "kernelVersion"] as const) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new LiteError("LITE_STATE_CORRUPT", `lock file is missing ${field}`);
    }
  }
  return record as unknown as LiteLockRecord;
}

/**
 * Single-writer project lock.
 *
 * The lock is advisory across processes. Stale takeover is explicit in the
 * result so callers can audit it; a corrupt lock is never silently replaced.
 */
export class LiteLock {
  private readonly lockFile: string;
  private readonly staleAfterMilliseconds: number;
  private readonly kernelVersion: string;
  private readonly now: () => Date;
  private token: string | null = null;

  constructor(options: LiteLockOptions) {
    this.lockFile = options.lockFile;
    this.staleAfterMilliseconds =
      options.staleAfterMilliseconds ?? DEFAULT_STALE_AFTER_MILLISECONDS;
    this.kernelVersion = options.kernelVersion ?? LITE_PACKAGE_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  async readHolder(): Promise<LiteLockRecord | null> {
    let text: string;
    try {
      text = await fs.readFile(this.lockFile, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw error;
    }
    try {
      return parseLockRecord(JSON.parse(text));
    } catch (error) {
      if (error instanceof LiteError) throw error;
      throw new LiteError("LITE_STATE_CORRUPT", "lock file is not valid JSON", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async acquire(options?: {
    readonly allowStaleTakeover?: boolean;
  }): Promise<LiteLockAcquireResult> {
    const allowStaleTakeover = options?.allowStaleTakeover ?? true;
    const record = this.createRecord();
    const first = await this.tryCreate(record);
    if (first) {
      this.token = record.token;
      return { acquired: true, record, wasStaleTakeover: false };
    }

    const holder = await this.readHolder();
    if (holder === null) {
      const retry = await this.tryCreate(record);
      if (retry) {
        this.token = record.token;
        return { acquired: true, record, wasStaleTakeover: false };
      }
      return { acquired: false, holder: await this.readHolder() };
    }

    if (!allowStaleTakeover || !this.isStale(holder)) {
      return { acquired: false, holder };
    }

    await fs.rm(this.lockFile, { force: true });
    const takeover = await this.tryCreate(record);
    if (!takeover) {
      return { acquired: false, holder: await this.readHolder() };
    }
    this.token = record.token;
    return { acquired: true, record, wasStaleTakeover: true };
  }

  async heartbeat(): Promise<boolean> {
    if (this.token === null) return false;
    const token = this.token;
    const holder = await this.readHolder();
    if (holder === null || holder.token !== token) return false;
    const updated: LiteLockRecord = {
      ...holder,
      heartbeatAtIso: this.now().toISOString(),
    };
    try {
      await writeJsonAtomic(this.lockFile, `${this.lockFile}.bak`, updated, {
        beforeCommit: async () => {
          const current = await this.readHolder();
          if (current === null || current.token !== token) {
            throw new LiteError("LITE_LOCK_HELD", "lock ownership changed before heartbeat commit");
          }
        },
      });
      return true;
    } catch (error) {
      if (error instanceof LiteError && error.code === "LITE_LOCK_HELD") return false;
      throw error;
    }
  }

  async release(): Promise<boolean> {
    if (this.token === null) return false;
    const holder = await this.readHolder();
    if (holder === null) {
      this.token = null;
      return false;
    }
    if (holder.token !== this.token) return false;
    await fs.rm(this.lockFile, { force: true });
    this.token = null;
    return true;
  }

  private createRecord(): LiteLockRecord {
    const timestamp = this.now().toISOString();
    return {
      schemaVersion: 1,
      token: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      startedAtIso: timestamp,
      heartbeatAtIso: timestamp,
      kernelVersion: this.kernelVersion,
    };
  }

  private async tryCreate(record: LiteLockRecord): Promise<boolean> {
    await fs.mkdir(path.dirname(this.lockFile), { recursive: true }).catch(() => undefined);

    let handle;
    try {
      handle = await fs.open(this.lockFile, "wx");
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") return false;
      throw error;
    }

    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  private isStale(record: LiteLockRecord): boolean {
    const heartbeat = Date.parse(record.heartbeatAtIso);
    if (!Number.isFinite(heartbeat)) {
      throw new LiteError("LITE_STATE_CORRUPT", "lock heartbeat timestamp is invalid");
    }
    return this.now().getTime() - heartbeat > this.staleAfterMilliseconds;
  }
}
