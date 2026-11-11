import { LiteJournal } from "../persistence/journal.js";
import { redactValue } from "./redaction.js";

/**
 * Append-only event journal with the shared redaction funnel. Every record is
 * redacted before it is serialized, so secrets and absolute paths never reach
 * the file.
 */
export class EventJournal {
  private readonly journal: LiteJournal;

  constructor(filePath: string) {
    this.journal = new LiteJournal(filePath);
  }

  async append(event: unknown): Promise<void> {
    await this.journal.append(redactValue(event));
  }

  async readAll<T = unknown>(): Promise<readonly T[]> {
    return this.journal.readAll<T>();
  }
}
