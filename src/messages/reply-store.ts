import { promises as fs } from "node:fs";
import path from "node:path";

import { LiteError } from "../contracts/errors.js";
import { createLiteIdentifier } from "../contracts/identifiers.js";
import { assertSafePathSegment, type LitePaths } from "../persistence/lite-paths.js";
import { LiteJournal } from "../persistence/journal.js";

export interface ReplyAttachment {
  readonly path: string;
  readonly sizeBytes: number;
}

export interface ReplyRecord {
  readonly schemaVersion: 1;
  readonly kind: "reply";
  readonly replyId: string;
  readonly runId: string;
  readonly text: string;
  readonly attachments: readonly ReplyAttachment[];
  readonly resolvesActiveUserMessage: boolean;
  readonly createdAtIso: string;
}

export interface ModelNoteRecord {
  readonly schemaVersion: 1;
  readonly kind: "model-note";
  readonly replyId: string;
  readonly runId: string;
  readonly text: string;
  readonly createdAtIso: string;
}

/**
 * Durable reply transcript. Each reply is written to the run transcript and to
 * a model-note journal for compatibility with the existing GUI reply reader.
 */
export class ReplyStore {
  private readonly paths: LitePaths;
  private readonly runId: string;
  private readonly runDirectory: string;
  private readonly now: () => Date;
  private readonly transcriptJournal: LiteJournal;
  private readonly modelNoteJournal: LiteJournal;

  constructor(options: { readonly paths: LitePaths; readonly runId: string; readonly now?: () => Date }) {
    assertSafePathSegment(options.runId, "runId");
    this.paths = options.paths;
    this.runId = options.runId;
    this.runDirectory = path.join(options.paths.runsDirectory, options.runId);
    this.now = options.now ?? (() => new Date());
    this.transcriptJournal = new LiteJournal(path.join(this.runDirectory, "transcript.jsonl"));
    this.modelNoteJournal = new LiteJournal(path.join(this.runDirectory, "model-notes.jsonl"));
  }

  async appendReply(input: {
    readonly text: string;
    readonly attachments: readonly ReplyAttachment[];
    readonly resolvesActiveUserMessage: boolean;
  }): Promise<ReplyRecord> {
    if (input.text.trim() === "") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "reply text must be non-empty");
    }
    if (input.text.length > 32_768) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "reply text is too long");
    }
    const createdAtIso = this.now().toISOString();
    const reply: ReplyRecord = {
      schemaVersion: 1,
      kind: "reply",
      replyId: createLiteIdentifier("msg"),
      runId: this.runId,
      text: input.text,
      attachments: input.attachments,
      resolvesActiveUserMessage: input.resolvesActiveUserMessage,
      createdAtIso,
    };
    await fs.mkdir(this.runDirectory, { recursive: true });
    await this.transcriptJournal.append(reply);
    const note: ModelNoteRecord = {
      schemaVersion: 1,
      kind: "model-note",
      replyId: reply.replyId,
      runId: this.runId,
      text: reply.text,
      createdAtIso,
    };
    await this.modelNoteJournal.append(note);
    return reply;
  }

  async readReplies(): Promise<readonly ReplyRecord[]> {
    const records = await this.transcriptJournal.readAll<ReplyRecord>();
    return records.filter((record) => record.kind === "reply");
  }

  getRunDirectory(): string {
    return this.runDirectory;
  }

  getRunId(): string {
    return this.runId;
  }

  getStateRoot(): string {
    return this.paths.stateRoot;
  }
}
