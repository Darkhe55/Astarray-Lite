import { LiteError } from "../contracts/errors.js";
import { createLiteIdentifier } from "../contracts/identifiers.js";
import type { LiteCapabilityId } from "./capabilities.js";

export type LitePermissionAskDecision = "allow-once" | "allow-session" | "deny";

export type LitePermissionAskStatus =
  | "pending"
  | "allowed-once"
  | "allowed-session"
  | "denied"
  | "expired";

export interface LitePermissionAskRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly capability: LiteCapabilityId;
  readonly toolName: string;
  readonly safePreview: string;
  readonly explanation: string;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
  readonly status: LitePermissionAskStatus;
}

export interface PermissionAskStoreOptions {
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
}

/**
 * In-memory ask queue. Pending requests are resolved by the UI/CLI control
 * plane; a timeout is deny. The store never accepts decisions from model tools.
 */
export class PermissionAskStore {
  private readonly now: () => Date;
  private readonly timeoutMilliseconds: number;
  private readonly requests = new Map<string, LitePermissionAskRequest>();
  private readonly waiters = new Map<string, (decision: LitePermissionAskDecision) => void>();

  constructor(options: PermissionAskStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 300_000;
    if (!Number.isInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds < 1) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "ask timeout must be a positive integer");
    }
  }

  create(input: {
    readonly capability: LiteCapabilityId;
    readonly toolName: string;
    readonly safePreview: string;
    readonly explanation: string;
  }): LitePermissionAskRequest {
    const now = this.now();
    const request: LitePermissionAskRequest = {
      schemaVersion: 1,
      requestId: createLiteIdentifier("ask", now.getTime()),
      capability: input.capability,
      toolName: input.toolName,
      safePreview: input.safePreview.slice(0, 2_000),
      explanation: input.explanation.slice(0, 2_000),
      createdAtIso: now.toISOString(),
      expiresAtIso: new Date(now.getTime() + this.timeoutMilliseconds).toISOString(),
      status: "pending",
    };
    this.requests.set(request.requestId, request);
    return request;
  }

  get(requestId: string): LitePermissionAskRequest | undefined {
    return this.requests.get(requestId);
  }

  listPending(): readonly LitePermissionAskRequest[] {
    return [...this.requests.values()].filter((request) => request.status === "pending");
  }

  resolve(requestId: string, decision: LitePermissionAskDecision): LitePermissionAskRequest {
    const request = this.requests.get(requestId);
    if (request === undefined) {
      throw new LiteError("LITE_PERMISSION_ASK_PENDING", "permission request not found");
    }
    if (request.status !== "pending") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "permission request is already resolved");
    }
    if (Date.parse(request.expiresAtIso) <= this.now().getTime()) {
      this.requests.set(requestId, { ...request, status: "expired" });
      throw new LiteError("LITE_PERMISSION_TIMEOUT", "permission request expired");
    }

    const status: LitePermissionAskStatus =
      decision === "allow-once"
        ? "allowed-once"
        : decision === "allow-session"
          ? "allowed-session"
          : "denied";
    const resolved: LitePermissionAskRequest = { ...request, status };
    this.requests.set(requestId, resolved);
    const waiter = this.waiters.get(requestId);
    this.waiters.delete(requestId);
    waiter?.(decision);
    return resolved;
  }

  async waitForDecision(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<LitePermissionAskDecision> {
    const request = this.requests.get(requestId);
    if (request === undefined) {
      throw new LiteError("LITE_PERMISSION_ASK_PENDING", "permission request not found");
    }
    if (request.status !== "pending") {
      return request.status === "denied" || request.status === "expired"
        ? "deny"
        : request.status === "allowed-session"
          ? "allow-session"
          : "allow-once";
    }

    return new Promise<LitePermissionAskDecision>((resolve) => {
      let settled = false;
      const settle = (decision: LitePermissionAskDecision): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(requestId);
        resolve(decision);
      };
      const timer = setTimeout(() => {
        const current = this.requests.get(requestId);
        if (current !== undefined && current.status === "pending") {
          this.requests.set(requestId, { ...current, status: "expired" });
        }
        settle("deny");
      }, Math.max(0, Date.parse(request.expiresAtIso) - this.now().getTime()));

      this.waiters.set(requestId, settle);
      if (signal !== undefined) {
        if (signal.aborted) {
          settle("deny");
        } else {
          signal.addEventListener(
            "abort",
            () => {
              settle("deny");
            },
            { once: true },
          );
        }
      }
    });
  }
}
