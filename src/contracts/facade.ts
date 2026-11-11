/**
 * Public application facade contract.
 *
 * The shape intentionally mirrors the core Astarray facade's required
 * methods so an existing UI can switch kernels without rewriting its pages.
 * Optional capability queries are added separately; unsupported core views
 * must be reported honestly by the implementation, never faked.
 */

import type { LiteCapabilityDescriptor } from "./capabilities.js";
import type {
  LiteEventListener,
  LiteEventSubscription,
} from "./events.js";
import type {
  LiteKernelOptions,
  LiteKernelSnapshot,
} from "./kernel-port.js";

export type LiteTaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface LiteTaskResult {
  readonly taskIdentifier: string;
  readonly missionIdentifier: string | null;
  readonly status: LiteTaskStatus;
  readonly summaryPreview: string | null;
}

export interface LiteSubmitTaskInput {
  readonly sessionId: string;
  readonly taskIdentifier: string;
  readonly prompt: string;
  readonly idempotencyKey?: string;
  readonly projectIdentifier?: string;
  readonly workspaceRootPath?: string;
}

export interface LiteApplicationOptions {
  readonly kernel: "lite";
  readonly stateDirectory: string;
  readonly workspaceRootPath: string;
  readonly projectIdentifier?: string;
  readonly sessionId?: string;
  readonly kernelOptions?: Omit<LiteKernelOptions, "stateDirectory" | "workspaceRootPath">;
}

export interface LiteApplicationFacade {
  subscribe(listener: LiteEventListener): LiteEventSubscription;
  submitTask(input: LiteSubmitTaskInput): Promise<LiteTaskResult>;
  cancelTask(input: { readonly sessionId: string; readonly taskIdentifier: string }): Promise<void>;
  queryCapabilities(): Promise<LiteCapabilityDescriptor>;
  querySnapshot(): Promise<LiteKernelSnapshot>;
}

export type LiteApplicationFactory = (
  options: LiteApplicationOptions,
) => Promise<LiteApplicationFacade>;
