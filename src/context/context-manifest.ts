import { LiteError } from "../contracts/errors.js";
import type {
  AssembledContext,
  LiteContextBlockId,
  LiteContextCacheClass,
} from "./context-assembler.js";

export interface LiteContextManifestBlock {
  readonly blockId: LiteContextBlockId;
  readonly cacheClass: LiteContextCacheClass;
  readonly contentHash: string;
  readonly tokenCount: number;
  readonly truncated: boolean;
  readonly originalTokenCount?: number;
  readonly sourceRevision?: number;
  readonly truncationReason?: string;
}

export interface LiteContextManifest {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly createdAtIso: string;
  readonly model: {
    readonly providerId: string;
    readonly modelIdentifier: string;
  };
  readonly tokenBudget: number;
  readonly totalTokenCount: number;
  readonly prefixHash: string;
  readonly blocks: readonly LiteContextManifestBlock[];
}

export function buildContextManifest(input: {
  readonly assembled: AssembledContext;
  readonly turnId: string;
  readonly createdAtIso: string;
  readonly providerId: string;
  readonly modelIdentifier: string;
  readonly tokenBudget: number;
  readonly countTokens: (text: string) => number;
  readonly trimmedBlockIds?: readonly LiteContextBlockId[] | undefined;
  readonly originalTokenCounts?: Partial<Record<LiteContextBlockId, number>> | undefined;
}): LiteContextManifest {
  if (input.turnId.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "turnId must be non-empty");
  }
  if (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 1) {
    throw new LiteError("LITE_INVALID_ARGUMENT", "tokenBudget must be a positive integer");
  }

  let totalTokenCount = 0;
  const trimmed = new Set(input.trimmedBlockIds ?? []);
  const blocks = input.assembled.blocks.map((block) => {
    const tokenCount = Math.max(0, Math.ceil(input.countTokens(block.serializedContent)));
    totalTokenCount += tokenCount;
    const originalTokenCount = input.originalTokenCounts?.[block.blockId];
    return {
      blockId: block.blockId,
      cacheClass: block.cacheClass,
      contentHash: block.contentHash,
      tokenCount,
      truncated: trimmed.has(block.blockId),
      ...(originalTokenCount === undefined ? {} : { originalTokenCount }),
      ...(trimmed.has(block.blockId) ? { truncationReason: "budget-trim" } : {}),
      ...(block.sourceRevision === undefined
        ? {}
        : { sourceRevision: block.sourceRevision }),
    };
  });

  return {
    schemaVersion: 1,
    turnId: input.turnId,
    createdAtIso: input.createdAtIso,
    model: {
      providerId: input.providerId,
      modelIdentifier: input.modelIdentifier,
    },
    tokenBudget: input.tokenBudget,
    totalTokenCount,
    prefixHash: input.assembled.prefixHash,
    blocks,
  };
}
