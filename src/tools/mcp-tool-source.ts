import { LiteError } from "../contracts/errors.js";
import type { LiteCapabilityId } from "../permissions/capabilities.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { LiteToolSpec } from "./tool-types.js";
import type { McpClient, McpToolDescriptor } from "../mcp/mcp-client.js";

export interface McpToolSourceOptions {
  readonly client: McpClient;
  readonly serverName: string;
  readonly capability?: LiteCapabilityId;
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/gu, "_");
  return sanitized === "" ? "tool" : sanitized;
}

export function mapMcpCapability(
  descriptor: McpToolDescriptor,
  explicit?: LiteCapabilityId,
): LiteCapabilityId {
  if (explicit !== undefined) return explicit;
  if (descriptor.annotations?.readOnlyHint === true) return "fs.read";
  if (descriptor.annotations?.readOnlyHint === false) return "process.shell";
  return "process.shell";
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
}

/**
 * Discovers MCP tools and maps them into the lite tool registry. Names are
 * always prefixed with the server (`mcp__<server>__<tool>`) so collisions are
 * impossible by construction; duplicate remote names fail closed.
 */
export class McpToolSource {
  private readonly client: McpClient;
  private readonly serverName: string;
  private readonly capability: LiteCapabilityId | undefined;
  private isInitialized = false;

  constructor(options: McpToolSourceOptions) {
    this.client = options.client;
    this.serverName = options.serverName;
    this.capability = options.capability;
  }

  async discover(): Promise<readonly LiteToolSpec[]> {
    if (!this.isInitialized) {
      await this.client.initialize();
      this.isInitialized = true;
    }
    const descriptors = await this.client.listTools();
    const seen = new Set<string>();
    return descriptors.map((descriptor) => {
      const name = mcpToolName(this.serverName, descriptor.name);
      if (seen.has(name)) {
        throw new LiteError("LITE_INVALID_ARGUMENT", `duplicate MCP tool name: ${name}`);
      }
      seen.add(name);
      const capability = mapMcpCapability(descriptor, this.capability);
      const isReadOnly = descriptor.annotations?.readOnlyHint === true;
      return {
        name,
        summary: descriptor.description ?? `MCP tool ${descriptor.name} from ${this.serverName}`,
        inputSchema: descriptor.inputSchema ?? { type: "object" },
        category: "installed",
        toolClass: isReadOnly ? "readonly" : "restricted",
        isIdempotent: descriptor.annotations?.idempotentHint ?? isReadOnly,
        requiresBackup: descriptor.annotations?.destructiveHint === true,
        capability,
        handler: async (argumentsValue) => {
          const result = await this.client.callTool(descriptor.name, argumentsValue);
          const outputText = result.content
            .map((entry) => entry.text ?? `[${entry.type}]`)
            .join("\n");
          return {
            outputText: outputText === "" ? "(empty MCP result)" : outputText,
            ...(result.isError === true ? { isError: true } : {}),
          };
        },
      } satisfies LiteToolSpec;
    });
  }

  async registerInto(registry: ToolRegistry): Promise<readonly LiteToolSpec[]> {
    const tools = await this.discover();
    for (const tool of tools) registry.register(tool);
    return tools;
  }
}
