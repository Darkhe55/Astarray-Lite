import { LiteError } from "../contracts/errors.js";
import type { LiteToolDefinition } from "../context/context-assembler.js";
import { canonicalJsonString } from "../context/canonical-json.js";
import { sha256Digest } from "../context/hash.js";
import { toContextToolDefinition, type LiteToolSpec } from "./tool-types.js";

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;

/**
 * In-memory tool catalogue. Disabled tools remain registered so the UI can
 * list and re-enable them, but they never enter the model schema or execute.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, LiteToolSpec>();
  private readonly disabled = new Set<string>();
  private revision = 1;

  register(spec: LiteToolSpec): void {
    if (!TOOL_NAME_PATTERN.test(spec.name)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "tool name is invalid", {
        toolName: spec.name,
      });
    }
    if (this.tools.has(spec.name)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "tool is already registered", {
        toolName: spec.name,
      });
    }
    if (spec.inputSchema === null || typeof spec.inputSchema !== "object") {
      throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "tool schema must be an object", {
        toolName: spec.name,
      });
    }
    if (typeof spec.handler !== "function") {
      throw new LiteError("LITE_TOOL_SCHEMA_INVALID", "tool handler must be a function", {
        toolName: spec.name,
      });
    }
    this.tools.set(spec.name, spec);
    this.revision += 1;
  }

  unregister(toolName: string): boolean {
    const removed = this.tools.delete(toolName);
    this.disabled.delete(toolName);
    if (removed) this.revision += 1;
    return removed;
  }

  enable(toolName: string): void {
    this.requireRegistered(toolName);
    if (this.disabled.delete(toolName)) this.revision += 1;
  }

  disable(toolName: string): void {
    this.requireRegistered(toolName);
    if (!this.disabled.has(toolName)) {
      this.disabled.add(toolName);
      this.revision += 1;
    }
  }

  isEnabled(toolName: string): boolean {
    return this.tools.has(toolName) && !this.disabled.has(toolName);
  }

  get(toolName: string): LiteToolSpec | undefined {
    return this.tools.get(toolName);
  }

  require(toolName: string): LiteToolSpec {
    const spec = this.tools.get(toolName);
    if (spec === undefined) {
      throw new LiteError("LITE_TOOL_NOT_FOUND", `tool not found: ${toolName}`, { toolName });
    }
    if (this.disabled.has(toolName)) {
      throw new LiteError("LITE_TOOL_DISABLED", `tool is disabled: ${toolName}`, { toolName });
    }
    return spec;
  }

  list(options: { readonly includeDisabled?: boolean } = {}): readonly LiteToolSpec[] {
    const includeDisabled = options.includeDisabled ?? false;
    return [...this.tools.values()]
      .filter((spec) => includeDisabled || !this.disabled.has(spec.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getContextDefinitions(): readonly LiteToolDefinition[] {
    return this.list().map(toContextToolDefinition);
  }

  getRevision(): number {
    return this.revision;
  }

  getDefinitionsHash(): string {
    return sha256Digest(canonicalJsonString(this.getContextDefinitions()));
  }

  private requireRegistered(toolName: string): void {
    if (!this.tools.has(toolName)) {
      throw new LiteError("LITE_TOOL_NOT_FOUND", `tool not found: ${toolName}`, { toolName });
    }
  }
}
