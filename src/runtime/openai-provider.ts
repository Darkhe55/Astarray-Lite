import type {
  LiteProvider,
  LiteProviderContentPart,
  LiteProviderRequest,
  LiteProviderResponse,
  LiteProviderMessage,
} from "./provider.js";

export interface ProviderFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type ProviderFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<ProviderFetchResponse>;

export interface OpenAiCompatibleProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly modelIdentifier: string;
  readonly providerId?: string;
  readonly fetchImpl?: ProviderFetch;
  readonly timeoutMilliseconds?: number;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

interface OpenAiContentPart {
  readonly type: "text" | "image_url";
  readonly text?: string;
  readonly image_url?: { readonly url: string };
}

interface OpenAiMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | readonly OpenAiContentPart[];
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
}

function toOpenAiContent(parts: readonly LiteProviderContentPart[]): readonly OpenAiContentPart[] {
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "image_url" as const,
          image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
        },
  );
}

function toOpenAiMessage(message: LiteProviderMessage): OpenAiMessage {
  return {
    role: message.role,
    content:
      message.contentParts === undefined
        ? message.content
        : toOpenAiContent(message.contentParts),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.callId,
            type: "function" as const,
            function: { name: call.toolName, arguments: call.argumentsJson },
          })),
        }),
  };
}

export class OpenAiCompatibleProvider implements LiteProvider {
  readonly providerId: string;
  readonly modelIdentifier: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: ProviderFetch;
  private readonly timeoutMilliseconds: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.providerId = options.providerId ?? "openai";
    this.modelIdentifier = options.modelIdentifier;
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl =
      options.fetchImpl ??
      ((url, init) =>
        fetch(url, init) as unknown as Promise<ProviderFetchResponse>);
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 120_000;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async complete(request: LiteProviderRequest): Promise<LiteProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: this.modelIdentifier,
          messages: request.messages.map(toOpenAiMessage),
          ...(request.tools.length === 0
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.summary,
                    parameters: tool.inputSchema,
                  },
                })),
              }),
          max_tokens: request.maxOutputTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return {
            kind: "error",
            code: "LITE_PROVIDER_AUTH_FAILED",
            message: "provider authentication failed",
            isRetryable: false,
          };
        }
        if (response.status === 429) {
          return {
            kind: "error",
            code: "LITE_PROVIDER_RATE_LIMITED",
            message: "provider rate limit",
            isRetryable: true,
          };
        }
        if (response.status >= 500) {
          return {
            kind: "error",
            code: "LITE_PROVIDER_REQUEST_FAILED",
            message: "provider temporary failure",
            isRetryable: true,
          };
        }
        return {
          kind: "error",
          code: "LITE_PROVIDER_REQUEST_FAILED",
          message: "provider request failed",
          isRetryable: false,
        };
      }

      const body = (await response.json()) as {
        readonly choices?: readonly {
          readonly message?: {
            readonly content?: string | null;
            readonly reasoning_content?: string | null;
            readonly reasoning?: string | null;
            readonly tool_calls?: readonly {
              readonly id?: string;
              readonly function?: { readonly name?: string; readonly arguments?: string };
            }[];
          };
        }[];
        readonly usage?: {
          readonly prompt_tokens?: number;
          readonly completion_tokens?: number;
          readonly prompt_tokens_details?: { readonly cached_tokens?: number };
        };
      };
      const choice = body.choices?.[0];
      if (choice === undefined) {
        return {
          kind: "error",
          code: "LITE_PROVIDER_REQUEST_FAILED",
          message: "provider returned no choices",
          isRetryable: true,
        };
      }
      const usage = {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cachedInputTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };
      const calls = (choice.message?.tool_calls ?? []).map((call, index) => ({
        callId: call.id ?? `call_${index}`,
        toolName: call.function?.name ?? "",
        argumentsJson: call.function?.arguments ?? "{}",
      }));
      const reasoning = (choice.message?.reasoning_content ?? choice.message?.reasoning ?? "").trim();
      if (calls.length > 0) {
        return {
          kind: "tool-calls",
          calls,
          text: choice.message?.content ?? "",
          ...(reasoning === "" ? {} : { reasoning }),
          usage,
        };
      }
      return {
        kind: "text",
        text: choice.message?.content ?? "",
        ...(reasoning === "" ? {} : { reasoning }),
        usage,
      };
    } catch {
      return {
        kind: "error",
        code: "LITE_PROVIDER_REQUEST_FAILED",
        message: "provider transport failed",
        isRetryable: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
