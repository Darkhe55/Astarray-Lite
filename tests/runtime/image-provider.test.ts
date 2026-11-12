import { describe, expect, it, vi } from "vitest";

import { OpenAiImageProvider, type ImageFetch, type ImageFetchResponse } from "../../src/runtime/image-provider.js";

function response(body: unknown, status = 200): ImageFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("OpenAiImageProvider", () => {
  it("sends multipart edits and parses base64 images", async () => {
    const fetchImpl = vi.fn<ImageFetch>(async () =>
      response({ data: [{ b64_json: "aGVsbG8=", revised_prompt: "better" }] }),
    );
    const provider = new OpenAiImageProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "dummy",
      fetchImpl,
    });
    const result = await provider.edit({
      imageBase64: "iVBORw==",
      mediaType: "image/png",
      prompt: "make it blue",
    });
    expect(result).toEqual({
      dataBase64: "aGVsbG8=",
      mediaType: "image/png",
      revisedPrompt: "better",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/v1/images/edits");
    expect(init?.headers.authorization).toBe("Bearer dummy");
    expect(init?.body.get("prompt")).toBe("make it blue");
    expect(init?.body.get("model")).toBe("gpt-image-1");
  });

  it("maps provider failures without leaking the key", async () => {
    const provider = new OpenAiImageProvider({
      baseUrl: "https://example.test",
      apiKey: "dummy",
      fetchImpl: async () => response({}, 429),
    });
    await expect(
      provider.edit({ imageBase64: "aGVsbG8=", mediaType: "image/png", prompt: "edit" }),
    ).rejects.toMatchObject({ code: "LITE_IMAGE_PROVIDER_FAILED" });
  });
});
