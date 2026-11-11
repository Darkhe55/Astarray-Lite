import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";

/**
 * Append-only JSONL journal.
 *
 * Writes are serialized in-process and fsynced before resolving. A malformed
 * line is a corruption signal: readers fail closed instead of skipping it.
 */
export class LiteJournal {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(event: unknown): Promise<void> {
    const run = async (): Promise<void> => {
      let line: string;
      try {
        line = `${JSON.stringify(event)}\n`;
      } catch (error) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "journal event is not JSON-serializable", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fs.open(this.filePath, "a");
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };

    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  async readAll<T>(): Promise<T[]> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return [];
      throw error;
    }

    const events: T[] = [];
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as T);
      } catch (error) {
        throw new LiteError("LITE_STATE_CORRUPT", "journal contains an invalid JSON line", {
          line: index + 1,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return events;
  }

  getFilePath(): string {
    return this.filePath;
  }
}
