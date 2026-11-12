import type { LiteTokenUsage } from "../contracts/events.js";
import type { LiteToolDefinition } from "../context/context-assembler.js";

export interface LiteProviderImagePart {
  readonly type: "image";
  readonly mediaType: string;
  readonly dataBase64: string;
}

export interface LiteProviderTextPart {
  readonly type: "text";
  readonly text: string;
}

export type LiteProviderContentPart = LiteProviderImagePart | LiteProviderTextPart;

export interface LiteProviderMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly contentParts?: readonly LiteProviderContentPart[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly LiteToolCall[];
}

export interface LiteToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export interface LiteProviderRequest {
  readonly providerId: string;
  readonly modelIdentifier: string;
  readonly messages: readonly LiteProviderMessage[];
  readonly tools: readonly LiteToolDefinition[];
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export type LiteProviderResponse =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly usage?: LiteTokenUsage;
    }
  | {
      readonly kind: "tool-calls";
      readonly calls: readonly LiteToolCall[];
      readonly text?: string;
      readonly usage?: LiteTokenUsage;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly isRetryable: boolean;
    };

export interface LiteProvider {
  readonly providerId: string;
  readonly modelIdentifier: string;
  complete(request: LiteProviderRequest): Promise<LiteProviderResponse>;
}
