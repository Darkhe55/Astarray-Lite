import { LiteError } from "../contracts/errors.js";
import { createLiteIdentifier } from "../contracts/identifiers.js";
import type { LitePaths } from "../persistence/lite-paths.js";
import { LiteJournal } from "../persistence/journal.js";
import { writeJsonAtomic } from "../persistence/state-store.js";
import {
  admitUserMessage,
  createUserMessage,
  resolveUserMessage,
  withdrawUserMessage,
  type CreateUserMessageInput,
  type LiteUserMessage,
  type LiteUserMessageDisposition,
} from "./user-message.js";

interface UserInboxIndex {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly updatedAtIso: string;
  readonly messages: readonly LiteUserMessage[];
}

type UserInboxEvent =
  | {
      readonly type: "enqueue";
      readonly message: LiteUserMessage;
      readonly idempotencyKey?: string;
    }
  | { readonly type: "admit"; readonly messageId: string; readonly atIso: string }
  | {
      readonly type: "resolve";
      readonly messageId: string;
      readonly disposition: LiteUserMessageDisposition;
      readonly reason?: string;
      readonly createdTaskIds?: readonly string[];
      readonly turnId?: string;
      readonly atIso: string;
    }
  | { readonly type: "withdraw"; readonly messageId: string; readonly atIso: string };

export interface UserInboxOptions {
  readonly paths: LitePaths;
  readonly now?: () => Date;
  readonly messageIdFactory?: () => string;
  readonly isIndexWriteEnabled?: boolean;
}

/**
 * Event-sourced user inbox.
 *
 * The JSONL journal is authoritative; `index.json` is a derived snapshot that
 * can be rebuilt at any time. Writes to the index are best-effort because the
 * journal already made the mutation durable.
 */
export class UserInbox {
  private readonly paths: LitePaths;
  private readonly journal: LiteJournal;
  private readonly now: () => Date;
  private readonly messageIdFactory: () => string;
  private readonly isIndexWriteEnabled: boolean;
  private readonly messages = new Map<string, LiteUserMessage>();
  private readonly idempotencyIndex = new Map<string, string>();
  private revision = 0;
  private isLoaded = false;

  constructor(options: UserInboxOptions) {
    this.paths = options.paths;
    this.journal = new LiteJournal(options.paths.inboxJournalFile);
    this.now = options.now ?? (() => new Date());
    this.messageIdFactory =
      options.messageIdFactory ?? (() => createLiteIdentifier("msg"));
    this.isIndexWriteEnabled = options.isIndexWriteEnabled ?? true;
  }

  async load(): Promise<void> {
    if (this.isLoaded) return;
    const events = await this.journal.readAll<UserInboxEvent>();
    for (const event of events) {
      this.apply(event);
    }
    this.isLoaded = true;
    await this.writeIndex();
  }

  async enqueue(input: CreateUserMessageInput & { readonly idempotencyKey?: string }): Promise<LiteUserMessage> {
    await this.load();
    if (input.idempotencyKey !== undefined) {
      const existingId = this.idempotencyIndex.get(input.idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.messages.get(existingId);
        if (existing !== undefined) return existing;
      }
    }

    const message = createUserMessage({
      ...input,
      messageId: input.messageId ?? this.messageIdFactory(),
      nowIso: input.nowIso ?? this.now().toISOString(),
    });
    const event: UserInboxEvent = {
      type: "enqueue",
      message,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    };
    await this.commit(event);
    return message;
  }

  async admitNext(): Promise<LiteUserMessage | null> {
    await this.load();
    const next = [...this.messages.values()].find((message) => message.status === "queued");
    if (next === undefined) return null;
    const event: UserInboxEvent = {
      type: "admit",
      messageId: next.messageId,
      atIso: this.now().toISOString(),
    };
    await this.commit(event);
    return this.messages.get(next.messageId) ?? null;
  }

  async resolve(input: {
    readonly messageId: string;
    readonly disposition: LiteUserMessageDisposition;
    readonly reason?: string;
    readonly createdTaskIds?: readonly string[];
    readonly turnId?: string;
  }): Promise<LiteUserMessage> {
    await this.load();
    if (!this.messages.has(input.messageId)) {
      throw new LiteError("LITE_USER_MESSAGE_NOT_FOUND", `message not found: ${input.messageId}`);
    }
    const event: UserInboxEvent = {
      type: "resolve",
      messageId: input.messageId,
      disposition: input.disposition,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.createdTaskIds === undefined ? {} : { createdTaskIds: input.createdTaskIds }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      atIso: this.now().toISOString(),
    };
    await this.commit(event);
    const resolved = this.messages.get(input.messageId);
    if (resolved === undefined) {
      throw new LiteError("LITE_USER_MESSAGE_NOT_FOUND", "message disappeared during resolution");
    }
    return resolved;
  }

  async withdraw(messageId: string): Promise<boolean> {
    await this.load();
    const message = this.messages.get(messageId);
    if (message === undefined) {
      throw new LiteError("LITE_USER_MESSAGE_NOT_FOUND", `message not found: ${messageId}`);
    }
    if (message.status !== "queued") return false;
    await this.commit({ type: "withdraw", messageId, atIso: this.now().toISOString() });
    return true;
  }

  list(): readonly LiteUserMessage[] {
    return [...this.messages.values()];
  }

  getActive(): LiteUserMessage | null {
    return [...this.messages.values()].find((message) => message.status === "admitted") ?? null;
  }

  getQueued(): readonly LiteUserMessage[] {
    return [...this.messages.values()].filter((message) => message.status === "queued");
  }

  private apply(event: UserInboxEvent): void {
    this.revision += 1;
    if (event.type === "enqueue") {
      this.messages.set(event.message.messageId, event.message);
      if (event.idempotencyKey !== undefined) {
        this.idempotencyIndex.set(event.idempotencyKey, event.message.messageId);
      }
      return;
    }

    const current = this.messages.get(event.messageId);
    if (current === undefined) {
      throw new LiteError("LITE_STATE_CORRUPT", `journal references missing message: ${event.messageId}`);
    }

    if (event.type === "admit") {
      this.messages.set(event.messageId, admitUserMessage(current, event.atIso));
      return;
    }
    if (event.type === "resolve") {
      this.messages.set(
        event.messageId,
        resolveUserMessage(current, {
          disposition: event.disposition,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(event.createdTaskIds === undefined ? {} : { createdTaskIds: event.createdTaskIds }),
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          atIso: event.atIso,
        }),
      );
      return;
    }
    this.messages.set(event.messageId, withdrawUserMessage(current, event.atIso));
  }

  private async commit(event: UserInboxEvent): Promise<void> {
    await this.journal.append(event);
    this.apply(event);
    await this.writeIndex();
  }

  private async writeIndex(): Promise<void> {
    if (!this.isIndexWriteEnabled) return;
    const index: UserInboxIndex = {
      schemaVersion: 1,
      revision: this.revision,
      updatedAtIso: this.now().toISOString(),
      messages: [...this.messages.values()],
    };
    await writeJsonAtomic(
      this.paths.inboxIndexFile,
      `${this.paths.inboxIndexFile}.bak`,
      index,
    ).catch(() => undefined);
  }
}
