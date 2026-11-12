import { randomUUID } from "node:crypto";

import type {
  LiteApprovalDecision,
  ProductApprovalRequest,
} from "./product-kernel.js";

export interface PendingApproval {
  readonly id: string;
  readonly request: ProductApprovalRequest;
  readonly createdAtIso: string;
}

interface PendingEntry extends PendingApproval {
  readonly resolve: (decision: LiteApprovalDecision) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * UI-facing approval queue. The kernel asks for a decision; the desktop layer
 * lists pending requests, renders the safe preview, and resolves by id.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly listeners = new Set<(pending: readonly PendingApproval[]) => void>();
  private readonly timeoutMilliseconds: number;

  constructor(options: { readonly timeoutMilliseconds?: number } = {}) {
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 300_000;
  }

  handler = async (request: ProductApprovalRequest): Promise<LiteApprovalDecision> => {
    return new Promise<LiteApprovalDecision>((resolve) => {
      const id = randomUUID();
      const timer =
        this.timeoutMilliseconds === 0
          ? undefined
          : setTimeout(() => {
              if (this.pending.delete(id)) {
                this.notify();
                resolve("deny");
              }
            }, this.timeoutMilliseconds);
      timer?.unref();
      this.pending.set(id, {
        id,
        request,
        createdAtIso: new Date().toISOString(),
        resolve,
        timer,
      });
      this.notify();
    });
  };

  list(): readonly PendingApproval[] {
    return [...this.pending.values()].map(({ id, request, createdAtIso }) => ({
      id,
      request,
      createdAtIso,
    }));
  }

  resolve(id: string, decision: LiteApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    this.pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.resolve(decision);
    this.notify();
    return true;
  }

  subscribe(listener: (pending: readonly PendingApproval[]) => void): { unsubscribe(): void } {
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  clear(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.resolve("deny");
    }
    this.pending.clear();
    this.notify();
  }

  private notify(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }
}
