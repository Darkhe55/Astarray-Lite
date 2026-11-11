import { LiteError } from "../contracts/errors.js";
import { createLiteIdentifier } from "../contracts/identifiers.js";

export const MAXIMUM_USER_MESSAGE_CHARACTERS = 32_768;

export type LiteUserMessageStatus = "queued" | "admitted" | "resolved";

export type LiteUserMessageDisposition = "answered" | "noise" | "converted-to-task";

export interface LiteUserMessageAttachment {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface LiteUserMessage {
  readonly schemaVersion: 1;
  readonly messageId: string;
  readonly revision: number;
  readonly text: string;
  readonly attachments: readonly LiteUserMessageAttachment[];
  readonly receivedAtIso: string;
  readonly source: "user" | "system";
  readonly status: LiteUserMessageStatus;
  readonly admittedAtIso?: string;
  readonly resolvedAtIso?: string;
  readonly disposition?: LiteUserMessageDisposition;
  readonly resolutionReason?: string;
  readonly createdTaskIds: readonly string[];
  readonly turnId?: string;
}

export interface CreateUserMessageInput {
  readonly text: string;
  readonly attachments?: readonly LiteUserMessageAttachment[];
  readonly source?: "user" | "system";
  readonly nowIso?: string;
  readonly messageId?: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be non-empty`);
  }
}

export function createUserMessage(input: CreateUserMessageInput): LiteUserMessage {
  if (input.text.trim() === "") {
    throw new LiteError("LITE_USER_MESSAGE_EMPTY", "user message must be non-empty");
  }
  if (input.text.length > MAXIMUM_USER_MESSAGE_CHARACTERS) {
    throw new LiteError("LITE_USER_MESSAGE_TOO_LARGE", "user message is too large", {
      length: input.text.length,
      maximum: MAXIMUM_USER_MESSAGE_CHARACTERS,
    });
  }
  const attachments = input.attachments ?? [];
  for (const attachment of attachments) {
    assertNonEmpty(attachment.path, "attachment.path");
    assertNonEmpty(attachment.mediaType, "attachment.mediaType");
    if (!Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "attachment.sizeBytes must be non-negative");
    }
  }

  return {
    schemaVersion: 1,
    messageId: input.messageId ?? createLiteIdentifier("msg"),
    revision: 1,
    text: input.text,
    attachments,
    receivedAtIso: input.nowIso ?? new Date().toISOString(),
    source: input.source ?? "user",
    status: "queued",
    createdTaskIds: [],
  };
}

export function admitUserMessage(message: LiteUserMessage, atIso: string): LiteUserMessage {
  if (message.status === "resolved") {
    throw new LiteError("LITE_USER_MESSAGE_ALREADY_RESOLVED", "message is already resolved");
  }
  if (message.status === "admitted") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "message is already admitted");
  }
  return {
    ...message,
    revision: message.revision + 1,
    status: "admitted",
    admittedAtIso: atIso,
  };
}

export function resolveUserMessage(
  message: LiteUserMessage,
  input: {
    readonly disposition: LiteUserMessageDisposition;
    readonly reason?: string;
    readonly createdTaskIds?: readonly string[];
    readonly turnId?: string;
    readonly atIso: string;
  },
): LiteUserMessage {
  if (message.status === "resolved") {
    throw new LiteError("LITE_USER_MESSAGE_ALREADY_RESOLVED", "message is already resolved");
  }
  if (message.status !== "admitted") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "message must be admitted before resolution");
  }
  if (input.disposition === "noise" && (input.reason ?? "").trim().length < 5) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "noise disposition requires a reason");
  }

  return {
    ...message,
    revision: message.revision + 1,
    status: "resolved",
    resolvedAtIso: input.atIso,
    disposition: input.disposition,
    ...(input.reason === undefined ? {} : { resolutionReason: input.reason }),
    createdTaskIds: input.createdTaskIds ?? message.createdTaskIds,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  };
}

export function withdrawUserMessage(message: LiteUserMessage, atIso: string): LiteUserMessage {
  if (message.status !== "queued") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "only queued messages can be withdrawn");
  }
  return {
    ...message,
    revision: message.revision + 1,
    status: "resolved",
    resolvedAtIso: atIso,
    resolutionReason: "withdrawn",
  };
}
