/**
 * Kernel event contract.
 *
 * Events are data-only and redacted at the source. They never carry prompts,
 * file contents, credentials or absolute host paths.
 */

export type LiteKernelStatus =
  | "booting"
  | "recovering"
  | "idle"
  | "listening"
  | "running"
  | "blocked"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

export type LiteTurnKind = "user" | "task" | "maintenance";

export type LiteTurnOutcome =
  | "completed"
  | "interrupted"
  | "failed"
  | "budget-exhausted"
  | "cancelled"
  | "timeout";

export interface LiteTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

interface LiteEventMetadata {
  readonly revision?: number;
  readonly idempotencyId?: string;
}

export type LiteEvent = LiteEventMetadata & (
  | {
      readonly type: "kernel.started";
      readonly atIso: string;
      readonly sessionId: string;
      readonly kernelVersion: string;
    }
  | {
      readonly type: "kernel.stopped";
      readonly atIso: string;
      readonly reason: string;
    }
  | {
      readonly type: "kernel.status";
      readonly atIso: string;
      readonly status: LiteKernelStatus;
    }
  | {
      readonly type: "turn.started";
      readonly atIso: string;
      readonly turnId: string;
      readonly kind: LiteTurnKind;
    }
  | {
      readonly type: "turn.finished";
      readonly atIso: string;
      readonly turnId: string;
      readonly outcome: LiteTurnOutcome;
      readonly durationMs: number;
    }
  | {
      readonly type: "provider.request";
      readonly atIso: string;
      readonly turnId: string;
      readonly requestId: string;
      readonly modelIdentifier: string;
    }
  | {
      readonly type: "provider.response";
      readonly atIso: string;
      readonly turnId: string;
      readonly usage: LiteTokenUsage;
    }
  | {
      readonly type: "tool.started";
      readonly atIso: string;
      readonly turnId: string;
      readonly callId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "tool.finished";
      readonly atIso: string;
      readonly turnId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly status: "ok" | "error";
      readonly durationMs: number;
    }
  | {
      readonly type: "permission.asked";
      readonly atIso: string;
      readonly requestId: string;
      readonly capabilityId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "permission.decided";
      readonly atIso: string;
      readonly requestId: string;
      readonly decision: "allow-once" | "allow-session" | "deny";
    }
  | {
      readonly type: "user-message.enqueued";
      readonly atIso: string;
      readonly messageId: string;
    }
  | {
      readonly type: "user-message.admitted";
      readonly atIso: string;
      readonly messageId: string;
    }
  | {
      readonly type: "user-message.resolved";
      readonly atIso: string;
      readonly messageId: string;
      readonly disposition: "answered" | "noise" | "converted-to-task";
    }
  | {
      readonly type: "task.created";
      readonly atIso: string;
      readonly taskId: string;
      readonly taskKind: "normal" | "goal";
    }
  | {
      readonly type: "task.updated";
      readonly atIso: string;
      readonly taskId: string;
      readonly revision: number;
    }
  | {
      readonly type: "task.completed";
      readonly atIso: string;
      readonly taskId: string;
    }
  | {
      readonly type: "task.archived";
      readonly atIso: string;
      readonly taskId: string;
      readonly disposition: "done" | "stale" | "cancelled";
    }
  | {
      readonly type: "goal.reviewed";
      readonly atIso: string;
      readonly taskId: string;
      readonly outcome: "continue" | "achieved" | "abandoned";
    }
  | {
      readonly type: "monitor.sampled";
      readonly atIso: string;
      readonly monitorId: string;
      readonly status: "ok" | "error" | "timeout";
      readonly durationMs: number;
    }
  | {
      readonly type: "monitor.alert";
      readonly atIso: string;
      readonly monitorId: string;
      readonly summary: string;
    }
  | {
      readonly type: "context.assembled";
      readonly atIso: string;
      readonly turnId: string;
      readonly prefixHash: string;
      readonly tokenCount: number;
      readonly cacheClass: "stable" | "task" | "volatile";
    }
  | {
      readonly type: "recovery.action";
      readonly atIso: string;
      readonly action: string;
      readonly detail: string;
    }
  | {
      readonly type: "error";
      readonly atIso: string;
      readonly code: string;
      readonly message: string;
    }
);

export type LiteEventListener = (event: LiteEvent) => void;

export interface LiteEventSubscription {
  unsubscribe(): void;
}

export function isLiteEvent(value: unknown): value is LiteEvent {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["type"] === "string" && typeof record["atIso"] === "string";
}
