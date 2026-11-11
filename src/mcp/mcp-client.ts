import { LiteError } from "../contracts/errors.js";

export interface McpTransport {
  request(payload: unknown, timeoutMilliseconds: number): Promise<unknown>;
  close?(): void | Promise<void>;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface McpToolCallContent {
  readonly type: string;
  readonly text?: string;
}

export interface McpToolCallResult {
  readonly content: readonly McpToolCallContent[];
  readonly isError?: boolean;
}

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Minimal MCP JSON-RPC client. It owns request ids and converts transport
 * failures into stable Lite errors; server-specific behavior stays in tools.
 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly timeoutMilliseconds: number;
  private nextRequestId = 1;
  private initialized = false;

  constructor(options: { readonly transport: McpTransport; readonly timeoutMilliseconds?: number }) {
    this.transport = options.transport;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    if (!Number.isInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds < 1) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "MCP timeout must be positive");
    }
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "astarray-lite", version: "0.0.0" },
    });
    this.initialized = true;
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    this.assertInitialized();
    const result = await this.send("tools/list", {});
    if (result === null || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) {
      throw new LiteError("LITE_MCP_PROTOCOL_ERROR", "tools/list result is invalid");
    }
    return (result as { tools: McpToolDescriptor[] }).tools;
  }

  async callTool(name: string, argumentsValue: unknown): Promise<McpToolCallResult> {
    this.assertInitialized();
    if (name.trim() === "") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "MCP tool name must be non-empty");
    }
    const result = await this.send("tools/call", { name, arguments: argumentsValue });
    if (result === null || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) {
      throw new LiteError("LITE_MCP_PROTOCOL_ERROR", "tools/call result is invalid");
    }
    return result as McpToolCallResult;
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new LiteError("LITE_MCP_PROTOCOL_ERROR", "MCP client is not initialized");
    }
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(new LiteError("LITE_MCP_TIMEOUT", `MCP request timed out: ${method}`)),
        );
      }, this.timeoutMilliseconds);

      this.transport.request(payload, this.timeoutMilliseconds).then(
        (response) => {
          settle(() => {
            try {
              resolve(this.parseResponse(response, id));
            } catch (error) {
              reject(error);
            }
          });
        },
        (error: unknown) => {
          settle(() =>
            reject(
              error instanceof LiteError
                ? error
                : new LiteError(
                    "LITE_MCP_DISCONNECTED",
                    `${method} transport failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
            ),
          );
        },
      );
    });
  }

  private parseResponse(response: unknown, expectedId: number): unknown {
    if (response === null || typeof response !== "object" || Array.isArray(response)) {
      throw new LiteError("LITE_MCP_PROTOCOL_ERROR", "MCP response is not an object");
    }
    const rpc = response as JsonRpcResponse;
    if (rpc.jsonrpc !== "2.0") {
      throw new LiteError("LITE_MCP_PROTOCOL_ERROR", "MCP response is missing jsonrpc 2.0");
    }
    if (rpc.id !== expectedId) {
      throw new LiteError("LITE_MCP_PROTOCOL_ERROR", "MCP response id does not match the request");
    }
    if (rpc.error !== undefined) {
      throw new LiteError("LITE_MCP_PROTOCOL_ERROR", `MCP error: ${rpc.error.message ?? "unknown"}`);
    }
    return rpc.result;
  }
}

export class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: { readonly url: string; readonly headers?: Readonly<Record<string, string>> }) {
    this.url = options.url;
    this.headers = options.headers ?? {};
  }

  async request(payload: unknown, timeoutMilliseconds: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LiteError("LITE_MCP_DISCONNECTED", `MCP HTTP status ${response.status}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
