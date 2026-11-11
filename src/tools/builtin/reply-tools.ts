import { promises as fs } from "node:fs";

import { LiteError } from "../../contracts/errors.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { LiteToolHandlerResult, LiteToolSpec } from "../tool-types.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "./path-safety.js";
import type { MessageSlot } from "../../messages/message-slot.js";
import type { ReplyAttachment, ReplyStore } from "../../messages/reply-store.js";

export interface ReplyToolOptions {
  readonly workspaceRoot: string;
  readonly replyStore: ReplyStore;
  readonly messageSlot: MessageSlot;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

async function resolveAttachments(input: {
  readonly workspaceRoot: string;
  readonly values: readonly string[];
}): Promise<readonly ReplyAttachment[]> {
  const attachments: ReplyAttachment[] = [];
  for (const relativePath of input.values) {
    const absolutePath = await resolveWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      relativePath,
    });
    assertNotSensitivePath(absolutePath);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch {
      throw new LiteError("LITE_FILE_NOT_FOUND", "attachment not found");
    }
    if (!stat.isFile()) {
      throw new LiteError("LITE_FILE_NOT_FOUND", "attachment is not a regular file");
    }
    attachments.push({ path: relativePath, sizeBytes: stat.size });
  }
  return attachments;
}

function buildReplyUserTool(options: ReplyToolOptions): LiteToolSpec {
  return {
    name: "reply_user",
    summary: "Send a Markdown reply to the user and optionally resolve the active message.",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 32_768 },
        resolvesActiveUserMessage: { type: "boolean" },
        attachments: {
          type: "array",
          items: { type: "string", minLength: 1 },
          maxItems: 20,
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const text = typeof record["text"] === "string" ? record["text"] : "";
      const resolvesActiveUserMessage = record["resolvesActiveUserMessage"] === true;
      const attachmentPaths = Array.isArray(record["attachments"])
        ? record["attachments"].filter((entry): entry is string => typeof entry === "string")
        : [];

      if (resolvesActiveUserMessage && options.messageSlot.getActive() === null) {
        throw new LiteError("LITE_USER_MESSAGE_NOT_FOUND", "there is no active user message to resolve");
      }
      const attachments = await resolveAttachments({
        workspaceRoot: options.workspaceRoot,
        values: attachmentPaths,
      });
      const reply = await options.replyStore.appendReply({
        text,
        attachments,
        resolvesActiveUserMessage,
      });
      if (resolvesActiveUserMessage) {
        await options.messageSlot.resolveActive({
          disposition: "answered",
          reason: "reply_user",
        });
      }
      return {
        outputText: `Reply sent (${reply.replyId})${resolvesActiveUserMessage ? "; active message resolved" : ""}`,
      };
    },
  };
}

function buildMarkUserMessageTool(options: ReplyToolOptions): LiteToolSpec {
  return {
    name: "mark_user_message",
    summary: "Mark the active user message as noise with a visible reason.",
    category: "basic",
    toolClass: "readonly",
    isIdempotent: false,
    requiresBackup: false,
    capability: "task.manage",
    inputSchema: {
      type: "object",
      properties: {
        disposition: { type: "string", enum: ["noise"] },
        reason: { type: "string", minLength: 5, maxLength: 500 },
      },
      required: ["disposition", "reason"],
      additionalProperties: false,
    },
    handler: async (argumentsValue): Promise<LiteToolHandlerResult> => {
      const record = asRecord(argumentsValue);
      const disposition = record["disposition"];
      const reason = typeof record["reason"] === "string" ? record["reason"].trim() : "";
      if (disposition !== "noise") {
        throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "disposition must be noise");
      }
      if (reason.length < 5) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "reason must be at least 5 characters");
      }
      const message = await options.messageSlot.markNoise(reason);
      return { outputText: `Marked ${message.messageId} as noise: ${reason}` };
    },
  };
}

export function registerReplyTools(registry: ToolRegistry, options: ReplyToolOptions): void {
  registry.register(buildReplyUserTool(options));
  registry.register(buildMarkUserMessageTool(options));
}
