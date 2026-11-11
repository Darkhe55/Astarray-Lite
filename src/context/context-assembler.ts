import { LiteError } from "../contracts/errors.js";
import { canonicalJsonString } from "./canonical-json.js";
import { sha256Digest, combineHashes } from "./hash.js";

export const LITE_CONTEXT_BLOCK_IDS = [
  "system",
  "tools",
  "memory",
  "task",
  "transcript",
  "monitor",
  "user",
] as const;

export type LiteContextBlockId = (typeof LITE_CONTEXT_BLOCK_IDS)[number];

export type LiteContextCacheClass = "stable" | "task" | "volatile";

export const LITE_CONTEXT_CACHE_CLASS: Readonly<Record<LiteContextBlockId, LiteContextCacheClass>> = {
  system: "stable",
  tools: "stable",
  memory: "stable",
  task: "task",
  transcript: "task",
  monitor: "volatile",
  user: "volatile",
};

export interface LiteToolDefinition {
  readonly name: string;
  readonly summary: string;
  readonly inputSchema: unknown;
  readonly category?: "basic" | "task" | "monitor" | "installed";
}

export interface LiteMemoryBlockInput {
  readonly profileText: string;
  readonly noteIndex: readonly { readonly path: string; readonly summary: string }[];
  readonly revision: number;
}

export interface LiteTaskContextInput {
  readonly taskId: string;
  readonly revision: number;
  readonly taskKind: "normal" | "goal";
  readonly documentText: string;
}

export interface LiteTranscriptTurn {
  readonly turnId: string;
  readonly role: "assistant" | "tool";
  readonly summary: string;
}

export interface LiteMonitorProjectionInput {
  readonly lines: readonly string[];
}

export interface LiteUserContextInput {
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly string[];
}

export interface LiteContextAssemblyInput {
  readonly promptVersion: string;
  readonly promptText: string;
  readonly toolsetRevision: number;
  readonly tools: readonly LiteToolDefinition[];
  readonly memory?: LiteMemoryBlockInput | undefined;
  readonly task?: LiteTaskContextInput | undefined;
  readonly transcript?: readonly LiteTranscriptTurn[] | undefined;
  readonly monitor?: LiteMonitorProjectionInput | undefined;
  readonly user?: LiteUserContextInput | undefined;
}

export interface AssembledContextBlock {
  readonly blockId: LiteContextBlockId;
  readonly cacheClass: LiteContextCacheClass;
  readonly content: unknown;
  readonly serializedContent: string;
  readonly contentHash: string;
  readonly sourceRevision?: number;
}

export interface AssembledContext {
  readonly blocks: readonly AssembledContextBlock[];
  readonly blockHashes: readonly string[];
  readonly prefixHash: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", `${field} must be non-empty`);
  }
}

function buildBlock(
  blockId: LiteContextBlockId,
  content: unknown,
  sourceRevision?: number,
): AssembledContextBlock {
  const serializedContent = canonicalJsonString(content);
  return {
    blockId,
    cacheClass: LITE_CONTEXT_CACHE_CLASS[blockId],
    content,
    serializedContent,
    contentHash: sha256Digest(serializedContent),
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
  };
}

/**
 * Assembles the seven context blocks in the fixed cache-friendly order.
 * Empty optional blocks are omitted; order of the remaining blocks is stable.
 */
export function assembleContext(input: LiteContextAssemblyInput): AssembledContext {
  assertNonEmpty(input.promptVersion, "promptVersion");
  assertNonEmpty(input.promptText, "promptText");
  if (!Number.isInteger(input.toolsetRevision) || input.toolsetRevision < 1) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "toolsetRevision must be a positive integer");
  }

  const blocks: AssembledContextBlock[] = [];
  blocks.push(
    buildBlock("system", {
      promptVersion: input.promptVersion,
      promptText: input.promptText,
    }),
  );

  const tools = [...input.tools]
    .map((tool) => ({
      name: tool.name,
      summary: tool.summary,
      inputSchema: tool.inputSchema,
      category: tool.category ?? "basic",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const toolNames = new Set<string>();
  for (const tool of tools) {
    assertNonEmpty(tool.name, "tool.name");
    if (toolNames.has(tool.name)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", `duplicate tool name: ${tool.name}`);
    }
    toolNames.add(tool.name);
  }
  blocks.push(
    buildBlock(
      "tools",
      { toolsetRevision: input.toolsetRevision, tools },
      input.toolsetRevision,
    ),
  );

  if (input.memory !== undefined) {
    blocks.push(
      buildBlock(
        "memory",
        {
          profileText: input.memory.profileText,
          noteIndex: input.memory.noteIndex,
        },
        input.memory.revision,
      ),
    );
  }

  if (input.task !== undefined) {
    blocks.push(
      buildBlock(
        "task",
        {
          taskId: input.task.taskId,
          taskKind: input.task.taskKind,
          documentText: input.task.documentText,
        },
        input.task.revision,
      ),
    );
  }

  if (input.transcript !== undefined && input.transcript.length > 0) {
    blocks.push(buildBlock("transcript", { turns: input.transcript }));
  }

  if (input.monitor !== undefined && input.monitor.lines.length > 0) {
    blocks.push(buildBlock("monitor", { lines: input.monitor.lines }));
  }

  if (input.user !== undefined && input.user.text.trim() !== "") {
    blocks.push(
      buildBlock("user", {
        messageId: input.user.messageId,
        text: input.user.text,
        attachments: input.user.attachments,
      }),
    );
  }

  const blockHashes = blocks.map((block) => block.contentHash);
  return {
    blocks,
    blockHashes,
    prefixHash: combineHashes(blockHashes),
  };
}
