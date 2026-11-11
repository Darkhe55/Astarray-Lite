import { LiteError } from "../contracts/errors.js";
import { canonicalJsonString } from "../context/canonical-json.js";
import { sha256Digest } from "../context/hash.js";
import type { ToolExecutionHooks } from "../tools/tool-executor.js";
import type { LiteToolSpec } from "../tools/tool-types.js";
import {
  DEFAULT_TOOL_CAPABILITY,
  LITE_PROFILE_MATRIX,
  USER_ONLY_CAPABILITIES,
  isLiteCapabilityId,
  type LiteCapabilityId,
  type LitePermissionDecision,
  type LitePermissionProfile,
} from "./capabilities.js";
import {
  PermissionAskStore,
  type LitePermissionAskDecision,
  type LitePermissionAskRequest,
} from "./ask-store.js";
import { createSafePreview } from "./safe-preview.js";

export type LiteToolPermissionOverride = LitePermissionDecision | "enable" | "disable";

export interface PermissionManagerOptions {
  readonly profile?: LitePermissionProfile;
  readonly toolOverrides?: Readonly<Record<string, LiteToolPermissionOverride>>;
  readonly capabilityOverrides?: Partial<Record<LiteCapabilityId, LitePermissionDecision>>;
  readonly askStore?: PermissionAskStore;
  readonly now?: () => Date;
  readonly sessionTtlMilliseconds?: number;
}

interface SessionGrant {
  readonly expiresAtMilliseconds: number;
}

const SESSION_GRANT_TTL_MILLISECONDS = 10 * 60 * 1_000;

function normalizeOverride(override: LiteToolPermissionOverride): LitePermissionDecision {
  if (override === "enable") return "allow";
  if (override === "disable") return "deny";
  return override;
}

export class PermissionManager {
  private profile: LitePermissionProfile;
  private readonly toolOverrides: Record<string, LiteToolPermissionOverride>;
  private readonly capabilityOverrides: Partial<Record<LiteCapabilityId, LitePermissionDecision>>;
  private readonly askStore: PermissionAskStore;
  private readonly now: () => Date;
  private readonly sessionTtlMilliseconds: number;
  private readonly sessionGrants = new Map<string, SessionGrant>();

  constructor(options: PermissionManagerOptions = {}) {
    this.profile = options.profile ?? "balanced";
    this.toolOverrides = { ...(options.toolOverrides ?? {}) };
    this.capabilityOverrides = { ...(options.capabilityOverrides ?? {}) };
    this.askStore = options.askStore ?? new PermissionAskStore();
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMilliseconds = options.sessionTtlMilliseconds ?? SESSION_GRANT_TTL_MILLISECONDS;
  }

  getProfile(): LitePermissionProfile {
    return this.profile;
  }

  setProfile(profile: LitePermissionProfile): void {
    this.profile = profile;
  }

  setToolOverride(toolName: string, override: LiteToolPermissionOverride): void {
    this.toolOverrides[toolName] = override;
  }

  clearToolOverride(toolName: string): void {
    delete this.toolOverrides[toolName];
  }

  decide(input: {
    readonly toolName: string;
    readonly capability?: LiteCapabilityId | undefined;
    readonly source?: "model" | "user";
  }): LitePermissionDecision {
    const source = input.source ?? "model";
    const capability = this.resolveCapability(input.toolName, input.capability);
    if (capability === undefined) return "deny";
    if (source === "model" && USER_ONLY_CAPABILITIES.has(capability)) return "deny";

    const toolOverride = this.toolOverrides[input.toolName];
    if (toolOverride !== undefined) return normalizeOverride(toolOverride);

    const capabilityOverride = this.capabilityOverrides[capability];
    if (capabilityOverride !== undefined) return capabilityOverride;

    return LITE_PROFILE_MATRIX[this.profile][capability];
  }

  createAsk(input: {
    readonly toolName: string;
    readonly capability?: LiteCapabilityId | undefined;
    readonly argumentsValue: unknown;
    readonly explanation?: string;
  }): LitePermissionAskRequest {
    const capability = this.resolveCapability(input.toolName, input.capability);
    if (capability === undefined) {
      throw new LiteError("LITE_PERMISSION_DENIED", "tool has no capability mapping");
    }
    return this.askStore.create({
      capability,
      toolName: input.toolName,
      safePreview: createSafePreview(input.toolName, input.argumentsValue),
      explanation: input.explanation ?? `Allow ${input.toolName} to use ${capability}?`,
    });
  }

  resolveAsk(requestId: string, decision: LitePermissionAskDecision): LitePermissionAskRequest {
    return this.askStore.resolve(requestId, decision);
  }

  listPendingAsks(): readonly LitePermissionAskRequest[] {
    return this.askStore.listPending();
  }

  async authorize(input: {
    readonly toolName: string;
    readonly capability?: LiteCapabilityId | undefined;
    readonly argumentsValue: unknown;
  }): Promise<LitePermissionDecision> {
    const capability = this.resolveCapability(input.toolName, input.capability);
    if (capability === undefined) return "deny";

    const decision = this.decide({
      toolName: input.toolName,
      capability,
      source: "model",
    });
    if (decision !== "ask") return decision;
    if (this.hasSessionGrant(capability, input.toolName, input.argumentsValue)) return "allow";
    return "ask";
  }

  async requestApproval(input: {
    readonly toolName: string;
    readonly capability?: LiteCapabilityId | undefined;
    readonly argumentsValue: unknown;
    readonly signal?: AbortSignal;
  }): Promise<boolean> {
    const capability = this.resolveCapability(input.toolName, input.capability);
    if (capability === undefined) return false;
    const request = this.createAsk({
      toolName: input.toolName,
      capability,
      argumentsValue: input.argumentsValue,
    });
    const decision = await this.askStore.waitForDecision(request.requestId, input.signal);
    if (decision === "deny") return false;
    if (decision === "allow-session") {
      this.grantSession(capability, input.toolName, input.argumentsValue);
    }
    return true;
  }

  grantSession(capability: LiteCapabilityId, toolName: string, argumentsValue: unknown): void {
    this.sessionGrants.set(this.sessionKey(capability, toolName, argumentsValue), {
      expiresAtMilliseconds: this.now().getTime() + this.sessionTtlMilliseconds,
    });
  }

  hasSessionGrant(capability: LiteCapabilityId, toolName: string, argumentsValue: unknown): boolean {
    const key = this.sessionKey(capability, toolName, argumentsValue);
    const grant = this.sessionGrants.get(key);
    if (grant === undefined) return false;
    if (grant.expiresAtMilliseconds <= this.now().getTime()) {
      this.sessionGrants.delete(key);
      return false;
    }
    return true;
  }

  getToolExecutionHooks(): ToolExecutionHooks {
    return {
      authorize: (spec, argumentsValue) =>
        this.authorize({
          toolName: spec.name,
          capability: spec.capability,
          argumentsValue,
        }),
      requestApproval: (spec, argumentsValue) =>
        this.requestApproval({
          toolName: spec.name,
          capability: spec.capability,
          argumentsValue,
        }),
    };
  }

  private resolveCapability(
    toolName: string,
    explicit: LiteCapabilityId | undefined,
  ): LiteCapabilityId | undefined {
    if (explicit !== undefined) {
      if (!isLiteCapabilityId(explicit)) {
        throw new LiteError("LITE_INVALID_ARGUMENT", "unknown capability");
      }
      return explicit;
    }
    return DEFAULT_TOOL_CAPABILITY[toolName];
  }

  private sessionKey(
    capability: LiteCapabilityId,
    toolName: string,
    argumentsValue: unknown,
  ): string {
    return `${capability}|${toolName}|${sha256Digest(canonicalJsonString(argumentsValue))}`;
  }
}

export type { LiteToolSpec };
