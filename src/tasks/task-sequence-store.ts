import type { LitePaths } from "../persistence/lite-paths.js";
import { readJsonWithBackup, writeJsonAtomic } from "../persistence/state-store.js";
import {
  createEmptyTaskSequence,
  validateTaskSequence,
  type LiteTaskSequence,
} from "./task-sequence.js";

/**
 * Authoritative persistence for the ordered task queue.
 *
 * Reads fall back to `.bak`; writes are atomic. Structural invariants are
 * checked on both sides so a hand-edited file cannot silently corrupt the
 * scheduler.
 */
export class TaskSequenceStore {
  private readonly paths: LitePaths;

  constructor(paths: LitePaths) {
    this.paths = paths;
  }

  async read(): Promise<LiteTaskSequence> {
    return (await this.readWithSource()).sequence;
  }

  async readWithSource(): Promise<{
    readonly sequence: LiteTaskSequence;
    readonly source: "primary" | "backup" | "empty";
  }> {
    const result = await readJsonWithBackup<LiteTaskSequence>(
      this.paths.sequenceFile,
      this.paths.sequenceBackupFile,
    );
    if (result === null) {
      return {
        sequence: createEmptyTaskSequence(new Date().toISOString()),
        source: "empty",
      };
    }
    validateTaskSequence(result.value);
    return { sequence: result.value, source: result.source };
  }

  async write(sequence: LiteTaskSequence): Promise<void> {
    validateTaskSequence(sequence);
    await writeJsonAtomic(this.paths.sequenceFile, this.paths.sequenceBackupFile, sequence);
  }

  async initialize(nowIso: string): Promise<LiteTaskSequence> {
    const sequence = createEmptyTaskSequence(nowIso);
    await this.write(sequence);
    return sequence;
  }
}
