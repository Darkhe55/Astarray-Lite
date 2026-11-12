import { describe, expect, it, vi } from "vitest";

import {
  OpenAiCompatibleProvider,
  type ProviderFetch,
  type ProviderFetchResponse,
} from "../../src/runtime/openai-provider.js";

const request = {
  providerId: "openai",
  modelIdentifier: "gpt-test",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [
    {
      name: "read_file",
      summary: "read",
      inputSchema: { type: "object" },
      category: "basic" as const,
    },
  ],
  maxOutputTokens: 100,
};

function response(body: unknown, status = 200): ProviderFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("OpenAiCompatibleProvider", () => {
  it("maps messages/tools and parses text with usage", async () => {
    const fetchImpl = vi.fn<ProviderFetch>(async () =>
      response({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } },
      }),
    );
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "dummy",
      modelIdentifier: "gpt-test",
      fetchImpl,
    });
    const result = await provider.complete(request);
    expect(result).toMatchObject({
      kind: "text",
      text: "hi",
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3 },
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(init?.headers.authorization).toBe("Bearer dummy");
    const body = JSON.parse(init?.body ?? "{}") as {
      model: string;
      max_tokens: number;
      messages: unknown[];
      tools: unknown[];
    };
    expect(body.model).toBe("gpt-test");
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.tools).toHaveLength(1);
  });

  it("parses tool calls and preserves text", async () => {
    const fetchImpl: ProviderFetch = async () =>
      response({
        choices: [
          {
            message: {
              content: "calling",
              tool_calls: [
                { id: "call-1", function: { name: "read_file", arguments: '{"path":"a"}' } },
              ],
            },
          },
        ],
      });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test",
      modelIdentifier: "gpt-test",
      fetchImpl,
    });
    const result = await provider.complete(request);
    expect(result).toMatchObject({
      kind: "tool-calls",
      text: "calling",
      calls: [{ callId: "call-1", toolName: "read_file", argumentsJson: '{"path":"a"}' }],
    });
  });

  it("maps image content parts to data URLs", async () => {
    const fetchImpl = vi.fn<ProviderFetch>(async () =>
      response({ choices: [{ message: { content: "seen" } }] }),
    );
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test",
      modelIdentifier: "gpt-test",
      fetchImpl,
    });
    await provider.complete({
      ...request,
      messages: [
        {
          role: "user",
          content: "see",
          contentParts: [
            { type: "text", text: "see" },
            { type: "image", mediaType: "image/png", dataBase64: "iVBORw==" },
          ],
        },
      ],
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}") as {
      messages: { content: unknown }[];
    };
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "see" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
    ]);
  });

  it("maps auth and rate-limit status without leaking keys", async () => {
    const authProvider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "dummy",
      modelIdentifier: "gpt-test",
      fetchImpl: async () => response({}, 401),
    });
    const auth = await authProvider.complete(request);
    expect(auth).toMatchObject({ kind: "error", code: "LITE_PROVIDER_AUTH_FAILED", isRetryable: false });
    expect(JSON.stringify(auth)).not.toContain("dummy");

    const limited = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test",
      modelIdentifier: "gpt-test",
      fetchImpl: async () => response({}, 429),
    });
    expect(await limited.complete(request)).toMatchObject({
      kind: "error",
      code: "LITE_PROVIDER_RATE_LIMITED",
      isRetryable: true,
    });
  });

  it("handles malformed responses and transport failures", async () => {
    const malformed = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test",
      modelIdentifier: "gpt-test",
      fetchImpl: async () => response({ choices: [] }),
    });
    expect((await malformed.complete(request)).kind).toBe("error");

    const failed = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test",
      modelIdentifier: "gpt-test",
      fetchImpl: async () => {
        throw new Error("socket");
      },
    });
    expect(await failed.complete(request)).toMatchObject({
      kind: "error",
      code: "LITE_PROVIDER_REQUEST_FAILED",
      isRetryable: true,
    });
  });
});
