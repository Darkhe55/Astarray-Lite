import type { LiteToolDefinition } from "../context/context-assembler.js";

export type LiteToolCategory = "basic" | "task" | "monitor" | "installed";

export type LiteToolClass = "readonly" | "restricted";

export interface LiteToolHandlerContext {
  readonly callId: string;
  readonly toolName: string;
  readonly signal: AbortSignal;
}

export interface LiteToolHandlerResult {
  readonly outputText: string;
  readonly isError?: boolean;
}

export type LiteToolHandler = (
  argumentsValue: unknown,
  context: LiteToolHandlerContext,
) => Promise<LiteToolHandlerResult>;

export interface LiteToolSpec extends LiteToolDefinition {
  readonly category: LiteToolCategory;
  readonly toolClass: LiteToolClass;
  readonly isIdempotent: boolean;
  readonly requiresBackup: boolean;
  readonly handler: LiteToolHandler;
  readonly timeoutMilliseconds?: number;
}

export interface LiteToolAuditRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly durationMilliseconds: number;
  readonly outputCharacters: number;
  readonly truncated: boolean;
  readonly executedAtIso: string;
}

export interface LiteToolExecutionResult {
  readonly ok: boolean;
  readonly callId: string;
  readonly toolName: string;
  readonly outputText: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly truncated: boolean;
  readonly durationMilliseconds: number;
}

export function toContextToolDefinition(spec: LiteToolSpec): LiteToolDefinition {
  return {
    name: spec.name,
    summary: spec.summary,
    inputSchema: spec.inputSchema,
    category: spec.category,
  };
}
