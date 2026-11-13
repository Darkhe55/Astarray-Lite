import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { OpenAiCompatibleProvider } from "../../src/runtime/openai-provider.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(): Promise<{ url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "pong" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

describe("OpenAiCompatibleProvider over local HTTP", () => {
  it("performs a real fetch round trip", async () => {
    const { url, requests } = await startServer();
    const provider = new OpenAiCompatibleProvider({
      baseUrl: url,
      apiKey: "dummy",
      modelIdentifier: "local-test",
      timeoutMilliseconds: 10_000,
    });
    const result = await provider.complete({
      providerId: "openai",
      modelIdentifier: "local-test",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      maxOutputTokens: 16,
    });
    expect(result).toMatchObject({ kind: "text", text: "pong" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "local-test", max_tokens: 16 });
  });
});
