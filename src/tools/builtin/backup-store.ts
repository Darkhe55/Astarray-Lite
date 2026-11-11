import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../../contracts/errors.js";
import { writeJsonAtomic } from "../../persistence/state-store.js";

export interface FileBackupRecord {
  readonly schemaVersion: 1;
  readonly backupId: string;
  readonly originalPath: string;
  readonly backupPath: string;
  readonly createdAtIso: string;
  readonly sizeBytes: number;
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
}
