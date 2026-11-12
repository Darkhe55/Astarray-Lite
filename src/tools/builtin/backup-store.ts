import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../../contracts/errors.js";
import { sha256Buffer } from "../../context/hash.js";
import { assertSafePathSegment } from "../../persistence/lite-paths.js";
import { writeJsonAtomic } from "../../persistence/state-store.js";

export interface FileBackupRecord {
  readonly schemaVersion: 1;
  readonly backupId: string;
  readonly originalPath: string;
  readonly backupPath: string;
  readonly createdAtIso: string;
  readonly sizeBytes: number;
  readonly contentHash?: string;
}

/**
 * Stores pre-image copies outside the workspace source tree. Backups are
 * intentionally not authoritative state; a failed backup aborts the mutation.
 */
export class FileBackupStore {
  private readonly backupRoot: string;
  private readonly now: () => Date;
  private readonly maximumBytes: number;

  constructor(options: {
    readonly stateRoot: string;
    readonly now?: () => Date;
    readonly maximumBytes?: number;
  }) {
    this.backupRoot = path.join(options.stateRoot, "file-backups");
    this.now = options.now ?? (() => new Date());
    this.maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024;
  }

  async backupExistingFile(input: {
    readonly absolutePath: string;
    readonly relativePath: string;
  }): Promise<FileBackupRecord | null> {
    let stat;
    try {
      stat = await fs.lstat(input.absolutePath);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw new LiteError("LITE_BACKUP_FAILED", "could not inspect the file before backup");
    }
    if (!stat.isFile()) {
      throw new LiteError("LITE_BACKUP_FAILED", "only regular files can be backed up");
    }
    if (stat.size > this.maximumBytes) {
      throw new LiteError("LITE_FILE_TOO_LARGE", "file is too large to back up");
    }

    const backupId = `${Date.now()}-${randomUUID()}`;
    const directory = path.join(this.backupRoot, backupId);
    const backupPath = path.join(directory, "snapshot.bin");
    const createdAtIso = this.now().toISOString();
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.copyFile(input.absolutePath, backupPath);
      const record: FileBackupRecord = {
        schemaVersion: 1,
        backupId,
        originalPath: input.relativePath,
        backupPath,
        createdAtIso,
        sizeBytes: stat.size,
        contentHash: sha256Buffer(await fs.readFile(backupPath)),
      };
      await writeJsonAtomic(
        path.join(directory, "manifest.json"),
        path.join(directory, "manifest.json.bak"),
        record,
      );
      return record;
    } catch (error) {
      if (error instanceof LiteError) throw error;
      throw new LiteError("LITE_BACKUP_FAILED", "could not create the pre-image backup");
    }
  }

  async listBackups(limit = 100): Promise<readonly FileBackupRecord[]> {
    let entries;
    try {
      entries = await fs.readdir(this.backupRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return [];
      throw error;
    }
    const records: FileBackupRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await this.readManifest(entry.name);
      if (record !== null) records.push(record);
    }
    records.sort((left, right) => right.createdAtIso.localeCompare(left.createdAtIso));
    return records.slice(0, Math.max(0, limit));
  }

  async restoreBackup(input: {
    readonly backupId: string;
    readonly workspaceRoot: string;
  }): Promise<FileBackupRecord> {
    assertSafePathSegment(input.backupId, "backupId");
    const record = await this.readManifest(input.backupId);
    if (record === null) {
      throw new LiteError("LITE_BACKUP_NOT_FOUND", "backup was not found");
    }
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const target = path.resolve(workspaceRoot, record.originalPath);
    const relative = path.relative(workspaceRoot, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new LiteError("LITE_PATH_OUT_OF_WORKSPACE", "backup target is outside the workspace");
    }
    const backupRelative = path.relative(this.backupRoot, record.backupPath);
    if (backupRelative === "" || backupRelative.startsWith("..") || path.isAbsolute(backupRelative)) {
      throw new LiteError("LITE_BACKUP_FAILED", "backup path is outside the backup store");
    }
    const content = await fs.readFile(record.backupPath);
    if (record.contentHash !== undefined && sha256Buffer(content) !== record.contentHash) {
      throw new LiteError("LITE_BACKUP_FAILED", "backup content hash does not match");
    }
    await this.backupExistingFile({ absolutePath: target, relativePath: record.originalPath });
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.restore-${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content);
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      if (error instanceof LiteError) throw error;
      throw new LiteError("LITE_BACKUP_FAILED", "could not restore the backup");
    }
    return record;
  }

  private async readManifest(backupId: string): Promise<FileBackupRecord | null> {
    const directory = path.join(this.backupRoot, backupId);
    let text: string;
    try {
      text = await fs.readFile(path.join(directory, "manifest.json"), "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (value === null || typeof value !== "object") return null;
    const record = value as Partial<FileBackupRecord>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.backupId !== "string" ||
      record.backupId !== backupId ||
      typeof record.originalPath !== "string" ||
      typeof record.backupPath !== "string" ||
      typeof record.createdAtIso !== "string" ||
      typeof record.sizeBytes !== "number"
    ) {
      return null;
    }
    return record as FileBackupRecord;
  }
}
