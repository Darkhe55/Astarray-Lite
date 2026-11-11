import { LiteError } from "../contracts/errors.js";
import {
  assembleContext,
  type AssembledContext,
  type LiteContextAssemblyInput,
  type LiteContextBlockId,
} from "./context-assembler.js";

export const DEFAULT_TOTAL_CONTEXT_TOKEN_BUDGET = 64_000;

export const DEFAULT_CONTEXT_BLOCK_BUDGETS: Readonly<Record<LiteContextBlockId, number>> = {
  system: 1_500,
  tools: 8_000,
  memory: 1_000,
  task: 4_000,
  transcript: 8_000,
  monitor: 1_000,
  user: 2_000,
};

export interface LiteContextBlockBudgets {
  readonly system: number;
  readonly tools: number;
  readonly memory: number;
  readonly task: number;
  readonly transcript: number;
  readonly monitor: number;
  readonly user: number;
}

export interface ContextTrimStep {
  readonly blockId: LiteContextBlockId;
  readonly reason: string;
  readonly beforeTokenCount: number;
  readonly afterTokenCount: number;
}

export interface ContextTrimResult {
  readonly assembled: AssembledContext;
  readonly totalTokenCount: number;
  readonly wasTrimmed: boolean;
  readonly steps: readonly ContextTrimStep[];
  readonly trimmedBlockIds: readonly LiteContextBlockId[];
}

/**
 * Cheap, deterministic token estimate. It is intentionally conservative for
 * mixed code/text: four Unicode code points per token, minimum zero.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let codePoints = 0;
  for (const _character of text) codePoints += 1;
  return Math.ceil(codePoints / 4);
}

function measure(
  assembled: AssembledContext,
  countTokens: (text: string) => number,
): Map<LiteContextBlockId, number> {
  const counts = new Map<LiteContextBlockId, number>();
  let total = 0;
  for (const block of assembled.blocks) {
    const raw = countTokens(block.serializedContent);
    const tokenCount = Number.isFinite(raw) ? Math.max(0, Math.ceil(raw)) : 0;
    counts.set(block.blockId, tokenCount);
    total += tokenCount;
  }
  counts.set("system", counts.get("system") ?? 0);
  return counts;
}

function totalOf(counts: ReadonlyMap<LiteContextBlockId, number>): number {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}

const TRUNCATION_MARKER = "\n[truncated]";

function truncateWithMarker(text: string, characterLimit: number): string {
  const markerLength = TRUNCATION_MARKER.length;
  const keep = Math.max(0, characterLimit - markerLength);
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}

/**
 * Applies the trim order from the design: transcript -> monitor -> task ->
 * memory -> user -> tools. `system` is never trimmed; if it alone exceeds its
 * budget, assembly fails closed.
 */
export function trimContext(
  input: LiteContextAssemblyInput,
  options: {
    readonly totalTokenBudget?: number;
    readonly blockBudgets?: LiteContextBlockBudgets;
    readonly countTokens?: (text: string) => number;
  } = {},
): ContextTrimResult {
  const totalTokenBudget = options.totalTokenBudget ?? DEFAULT_TOTAL_CONTEXT_TOKEN_BUDGET;
  const blockBudgets = options.blockBudgets ?? DEFAULT_CONTEXT_BLOCK_BUDGETS;
  const countTokens = options.countTokens ?? estimateTokens;

  if (!Number.isInteger(totalTokenBudget) || totalTokenBudget < 1) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "totalTokenBudget must be a positive integer");
  }

  const current: {
    -readonly [K in keyof LiteContextAssemblyInput]: LiteContextAssemblyInput[K];
  } = { ...input };
  let assembled = assembleContext(current);
  let counts = measure(assembled, countTokens);
  const steps: ContextTrimStep[] = [];
  const trimmedBlockIds = new Set<LiteContextBlockId>();

  const rebuild = (): void => {
    assembled = assembleContext(current);
    counts = measure(assembled, countTokens);
  };

  const overBlockBudget = (blockId: LiteContextBlockId): boolean =>
    (counts.get(blockId) ?? 0) > blockBudgets[blockId];

  const record = (
    blockId: LiteContextBlockId,
    reason: string,
    before: number,
  ): void => {
    rebuild();
    const after = counts.get(blockId) ?? 0;
    if (after < before) {
      steps.push({ blockId, reason, beforeTokenCount: before, afterTokenCount: after });
      trimmedBlockIds.add(blockId);
    }
  };

  if (overBlockBudget("system")) {
    throw new LiteError("LITE_CONTEXT_BUDGET_EXCEEDED", "system block exceeds its budget", {
      block: "system",
      tokenCount: counts.get("system") ?? 0,
      budget: blockBudgets.system,
    });
  }

  if (overBlockBudget("transcript") && current.transcript !== undefined && current.transcript.length > 3) {
    const before = counts.get("transcript") ?? 0;
    current.transcript = current.transcript.slice(-3);
    record("transcript", "keep the last three task turns", before);
  }

  if (overBlockBudget("monitor") && current.monitor !== undefined && current.monitor.lines.length > 1) {
    const before = counts.get("monitor") ?? 0;
    const alerts = current.monitor.lines.filter((line) => /alert|error|fail/iu.test(line));
    current.monitor = { lines: alerts.length > 0 ? alerts : current.monitor.lines.slice(-1) };
    record("monitor", "keep alerts and a single summary line", before);
  }

  if (overBlockBudget("task") && current.task !== undefined && current.task.documentText.length > 2_000) {
    const before = counts.get("task") ?? 0;
    const limit = Math.min(2_000, blockBudgets.task);
    current.task = {
      ...current.task,
      documentText: truncateWithMarker(current.task.documentText, limit),
    };
    record("task", "compact the task document projection", before);
  }

  if (overBlockBudget("memory") && current.memory !== undefined && current.memory.noteIndex.length > 0) {
    const before = counts.get("memory") ?? 0;
    current.memory = { ...current.memory, noteIndex: [] };
    record("memory", "drop the note index and keep the profile", before);
  }

  if (overBlockBudget("user") && current.user !== undefined && current.user.text.length > 8_000) {
    const before = counts.get("user") ?? 0;
    const limit = Math.min(8_000, blockBudgets.user);
    current.user = { ...current.user, text: truncateWithMarker(current.user.text, limit) };
    record("user", "truncate the active user message", before);
  }

  if (overBlockBudget("tools") && current.tools.length > 0) {
    const before = counts.get("tools") ?? 0;
    const kept = current.tools.filter((tool) => (tool.category ?? "basic") !== "installed");
    if (kept.length > 0) {
      current.tools = kept;
      record("tools", "drop installed tools while keeping task and basic tools", before);
    }
  }

  if (totalOf(counts) > totalTokenBudget) {
    if (current.transcript !== undefined && current.transcript.length > 1) {
      const before = counts.get("transcript") ?? 0;
      current.transcript = current.transcript.slice(-1);
      record("transcript", "global budget: keep only the last turn", before);
    }
  }

  if (totalOf(counts) > totalTokenBudget) {
    if (current.task !== undefined && current.task.documentText.length > 1_000) {
      const before = counts.get("task") ?? 0;
      const limit = Math.min(1_000, blockBudgets.task);
      current.task = {
        ...current.task,
        documentText: truncateWithMarker(current.task.documentText, limit),
      };
      record("task", "global budget: minimal task projection", before);
    }
  }

  if (totalOf(counts) > totalTokenBudget) {
    if (current.user !== undefined && current.user.text.length > 4_000) {
      const before = counts.get("user") ?? 0;
      const limit = Math.min(4_000, blockBudgets.user);
      current.user = { ...current.user, text: truncateWithMarker(current.user.text, limit) };
      record("user", "global budget: keep the message head", before);
    }
  }

  if (totalOf(counts) > totalTokenBudget) {
    if (current.memory !== undefined && current.memory.profileText.length > 2_000) {
      const before = counts.get("memory") ?? 0;
      const limit = Math.min(2_000, blockBudgets.memory);
      current.memory = {
        ...current.memory,
        profileText: truncateWithMarker(current.memory.profileText, limit),
        noteIndex: [],
      };
      record("memory", "global budget: truncate the profile", before);
    }
  }

  if (totalOf(counts) > totalTokenBudget) {
    throw new LiteError("LITE_CONTEXT_BUDGET_EXCEEDED", "context exceeds the token budget", {
      totalTokenCount: totalOf(counts),
      totalTokenBudget,
    });
  }

  return {
    assembled,
    totalTokenCount: totalOf(counts),
    wasTrimmed: steps.length > 0,
    steps,
    trimmedBlockIds: [...trimmedBlockIds],
  };
}

