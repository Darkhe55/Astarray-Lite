/**
 * Kernel port: the narrow surface an embedding host (CLI, GUI, tests) uses.
 *
 * The port deliberately exposes lifecycle, user-message admission and a
 * read-only snapshot. Task, goal and monitor management stay behind tools so
 * the model cannot bypass the queue invariants.
 */

import type {
  LiteEventListener,
  LiteEventSubscription,
  LiteKernelStatus,
  LiteTokenUsage,
} from "./events.js";

export interface LiteAttachment {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface LiteUserMessageInput {
  readonly text: string;
  readonly attachments?: readonly LiteAttachment[];
  readonly idempotencyKey?: string;
}

export interface LiteUserMessageReceipt {
  readonly messageId: string;
  readonly status: "queued" | "admitted";
  readonly receivedAtIso: string;
}

export interface LiteKernelSnapshot {
  readonly schemaVersion: 1;
  readonly kernel: "lite";
  readonly sessionId: string;
  readonly projectIdentifier: string;
  readonly status: LiteKernelStatus;
  readonly activeUserMessageId: string | null;
  readonly activeTaskId: string | null;
  readonly pendingTaskCount: number;
  readonly goalCount: number;
  readonly tokenUsage: LiteTokenUsage;
  readonly updatedAtIso: string;
}

export interface LiteKernelOptions {
  readonly stateDirectory: string;
  readonly workspaceRootPath: string;
  readonly projectIdentifier?: string;
  readonly sessionId?: string;
  readonly listenerTickIntervalMilliseconds?: number;
  readonly contextTokenBudget?: number;
}

export interface LiteKernelPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  submitUserMessage(input: LiteUserMessageInput): Promise<LiteUserMessageReceipt>;
  withdrawUserMessage(messageId: string): Promise<boolean>;
  getSnapshot(): Promise<LiteKernelSnapshot>;
  subscribe(listener: LiteEventListener): LiteEventSubscription;
}
