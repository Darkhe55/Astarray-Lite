import { describe, expect, it } from "vitest";

import { McpClient, type McpTransport } from "../../src/mcp/mcp-client.js";
import { McpToolSource, mcpToolName } from "../../src/tools/mcp-tool-source.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

interface JsonRpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

class FakeMcpTransport implements McpTransport {
  readonly requests: JsonRpcRequest[] = [];
  constructor(
    private readonly handler: (request: JsonRpcRequest) => unknown | Promise<unknown>,
  ) {}

  async request(payload: unknown): Promise<unknown> {
    const request = payload as JsonRpcRequest;
    this.requests.push(request);
    const result = await this.handler(request);
    return { jsonrpc: "2.0", id: request.id, result };
  }
}

describe("McpClient", () => {
  it("initializes, lists tools and calls them", async () => {
    const transport = new FakeMcpTransport((request) => {
      if (request.method === "initialize") return { protocolVersion: "2024-11-05" };
      if (request.method === "tools/list") {
        return { tools: [{ name: "read", inputSchema: { type: "object" } }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    });
    const client = new McpClient({ transport });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools[0]?.name).toBe("read");
    const result = await client.callTool("read", { path: "a.txt" });
    expect(result.content[0]?.text).toBe("ok");
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "tools/list",
      "tools/call",
    ]);
  });

  it("reports timeouts and disconnects with stable codes", async () => {
    const timeoutClient = new McpClient({
      transport: { request: async () => new Promise(() => undefined) },
      timeoutMilliseconds: 10,
    });
    await expect(timeoutClient.initialize()).rejects.toMatchObject({ code: "LITE_MCP_TIMEOUT" });

    const disconnectedClient = new McpClient({
      transport: {
        request: async () => {
          throw new Error("socket closed");
        },
      },
    });
    await expect(disconnectedClient.initialize()).rejects.toMatchObject({
      code: "LITE_MCP_DISCONNECTED",
    });
  });

  it("rejects mismatched JSON-RPC responses", async () => {
    const client = new McpClient({
      transport: { request: async () => ({ jsonrpc: "2.0", id: 999, result: {} }) },
    });
    await expect(client.initialize()).rejects.toMatchObject({ code: "LITE_MCP_PROTOCOL_ERROR" });
  });
});

describe("McpToolSource", () => {
  it("prefixes names and maps read-only annotations to fs.read", async () => {
    const transport = new FakeMcpTransport((request) => {
      if (request.method === "initialize") return {};
      if (request.method === "tools/list") {
        return {
          tools: [
            { name: "read", description: "read a file", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
            { name: "run", description: "run", inputSchema: { type: "object" } },
          ],
        };
      }
      return { content: [{ type: "text", text: "called" }] };
    });
    const source = new McpToolSource({ client: new McpClient({ transport }), serverName: "demo" });
    const tools = await source.discover();
    expect(tools.map((tool) => tool.name)).toEqual([
      mcpToolName("demo", "read"),
      mcpToolName("demo", "run"),
    ]);
    expect(tools[0]?.capability).toBe("fs.read");
    expect(tools[1]?.capability).toBe("process.shell");
    expect(tools[0]?.category).toBe("installed");
  });

  it("registers discovered tools and proxies calls", async () => {
    const transport = new FakeMcpTransport((request) => {
      if (request.method === "initialize") return {};
      if (request.method === "tools/list") {
        return { tools: [{ name: "run", inputSchema: { type: "object" } }] };
      }
      return { content: [{ type: "text", text: "proxied" }] };
    });
    const registry = new ToolRegistry();
    const source = new McpToolSource({ client: new McpClient({ transport }), serverName: "demo" });
    await source.registerInto(registry);
    const tool = registry.get(mcpToolName("demo", "run"));
    expect(tool).toBeDefined();
    const result = await tool?.handler({}, { callId: "c1", toolName: tool.name, signal: new AbortController().signal });
    expect(result?.outputText).toBe("proxied");
  });

  it("rejects duplicate remote tool names after prefixing", async () => {
    const transport = new FakeMcpTransport((request) => {
      if (request.method === "initialize") return {};
      return { tools: [{ name: "read" }, { name: "read" }] };
    });
    const source = new McpToolSource({ client: new McpClient({ transport }), serverName: "demo" });
    await expect(source.discover()).rejects.toMatchObject({ code: "LITE_INVALID_ARGUMENT" });
  });
});
