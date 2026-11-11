import { canonicalJsonString } from "../context/canonical-json.js";
import { sha256Digest } from "../context/hash.js";

export type LoopGuardAction = "continue" | "pause" | "cycle";

export interface LoopGuardHistoryEntry {
  readonly toolName: string;
  readonly signature: string;
}

export interface LoopGuardOptions {
  readonly repeatThreshold?: number;
  readonly maximumHistory?: number;
}

/**
 * Detects repeated tool calls with identical arguments and short A→B→A loops.
 * The executor can turn `pause`/`cycle` into a blocked turn; the guard itself
 * does not mutate the call.
 */
export class LoopGuard {
  private readonly repeatThreshold: number;
  private readonly maximumHistory: number;
  private readonly history: LoopGuardHistoryEntry[] = [];

  constructor(options: LoopGuardOptions = {}) {
    this.repeatThreshold = options.repeatThreshold ?? 3;
    this.maximumHistory = options.maximumHistory ?? 100;
    if (!Number.isInteger(this.repeatThreshold) || this.repeatThreshold < 2) {
      throw new Error("repeatThreshold must be at least 2");
    }
  }

  record(toolName: string, argumentsValue: unknown): LoopGuardAction {
    const signature = sha256Digest(
      canonicalJsonString({ toolName, arguments: argumentsValue }),
    );
    this.history.push({ toolName, signature });
    if (this.history.length > this.maximumHistory) this.history.shift();

    const identical = this.history.filter((entry) => entry.signature === signature).length;
    if (identical >= this.repeatThreshold) return "pause";

    const lastThree = this.history.slice(-3);
    if (
      lastThree.length === 3 &&
      lastThree[0]?.signature === lastThree[2]?.signature &&
      lastThree[0]?.signature !== lastThree[1]?.signature
    ) {
      return "cycle";
    }
    return "continue";
  }

  getHistory(): readonly LoopGuardHistoryEntry[] {
    return [...this.history];
  }

  reset(): void {
    this.history.length = 0;
  }
}
