import type { ReplyRecord } from "../messages/reply-store.js";

export interface GuiHistoryMessage {
  readonly messageId: string;
  readonly role: "assistant";
  readonly text: string;
  readonly atIso: string;
  readonly attachments: readonly { readonly path: string; readonly sizeBytes: number }[];
}

/**
 * Read-only history projection for the GUI. It exposes only assistant replies
 * and attachment metadata, never file contents or local absolute paths.
 */
export function projectGuiHistory(
  replies: readonly ReplyRecord[],
  options: { readonly limit?: number } = {},
): readonly GuiHistoryMessage[] {
  const limit = options.limit ?? 200;
  return replies
    .slice(-limit)
    .map((reply) => ({
      messageId: reply.replyId,
      role: "assistant" as const,
      text: reply.text,
      atIso: reply.createdAtIso,
      attachments: reply.attachments.map((attachment) => ({
        path: attachment.path,
        sizeBytes: attachment.sizeBytes,
      })),
    }));
}
