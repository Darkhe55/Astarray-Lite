import { describe, expect, it } from "vitest";

import { OpenAiCompatibleProvider } from "../../src/runtime/openai-provider.js";

const apiKey = process.env["ASTRARRAY_LITE_API_KEY"];
const live = apiKey !== undefined && apiKey.trim() !== "";

/**
 * Opt-in live provider check. It runs only when ASTRARRAY_LITE_API_KEY is set;
 * CI stays offline by default. Never print the key or full request headers.
 */
describe.skipIf(!live)("live OpenAI-compatible provider", () => {
  it(
    "completes a minimal text turn",
    async () => {
      const provider = new OpenAiCompatibleProvider({
        baseUrl: process.env["ASTRARRAY_LITE_BASE_URL"] ?? "https://api.openai.com/v1",
        apiKey: apiKey ?? "",
        modelIdentifier: process.env["ASTRARRAY_LITE_MODEL"] ?? "gpt-4.1-mini",
        timeoutMilliseconds: 60_000,
      });
      const result = await provider.complete({
        providerId: "openai",
        modelIdentifier: provider.modelIdentifier,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        tools: [],
        maxOutputTokens: 16,
      });
      expect(result.kind).toBe("text");
      if (result.kind === "text") {
        expect(result.text.trim().length).toBeGreaterThan(0);
      }
    },
    90_000,
  );
});
