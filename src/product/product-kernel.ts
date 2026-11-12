import { LiteError } from "../contracts/errors.js";
import type { LiteEventListener, LiteEventSubscription } from "../contracts/events.js";
import type {
  LiteKernelPort,
  LiteKernelSnapshot,
  LiteUserMessageInput,
  LiteUserMessageReceipt,
} from "../contracts/kernel-port.js";
import { UserInbox } from "../inbox/user-inbox.js";
import { LiteKernelRuntime, type LiteKernelTurnResult } from "../kernel/lite-kernel.js";
import { ListenerLoop } from "../kernel/listener-loop.js";
import { MessageSlot } from "../messages/message-slot.js";
import { ReplyStore } from "../messages/reply-store.js";
import { UserTurnController } from "../messages/user-turn.js";
import { resolveLitePaths, type LitePaths } from "../persistence/lite-paths.js";
import { LiteLock } from "../persistence/lock.js";
import { recoverLiteState } from "../persistence/recovery.js";
import { PermissionManager } from "../permissions/permission-manager.js";
import type { LiteCapabilityId, LitePermissionProfile } from "../permissions/capabilities.js";
import { createSafePreview } from "../permissions/safe-preview.js";
import type { LiteProvider } from "../runtime/provider.js";
import type { ShellProcessRunner } from "../tools/builtin/shell-tool.js";
import { registerFileTools } from "../tools/builtin/file-tools.js";
import { registerReplyTools } from "../tools/builtin/reply-tools.js";
import { registerShellTool } from "../tools/builtin/shell-tool.js";
import { registerTaskTools } from "../tools/builtin/task-tools.js";
import { ToolExecutor, type ToolExecutionHooks } from "../tools/tool-executor.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { TaskSequenceStore } from "../tasks/task-sequence-store.js";
import { TaskStore } from "../tasks/task-store.js";
import { projectGoals, type LiteGoalProjection } from "../facade/goal-projection.js";

export type LiteApprovalDecision = "allow-once" | "allow-session" | "deny";

export interface ProductApprovalRequest {
  readonly toolName: string;
  readonly capability: LiteCapabilityId | undefined;
  readonly safePreview: string;
}

export interface ProductKernelOptions {
  readonly workspaceRootPath: string;
  readonly stateDirectory?: string;
  readonly sessionId: string;
  readonly projectIdentifier: string;
  readonly provider: LiteProvider;
  readonly profile?: LitePermissionProfile;
  readonly approvalHandler?: (request: ProductApprovalRequest) => Promise<LiteApprovalDecision>;
  readonly systemPromptText?: string;
  readonly systemPromptVersion?: string;
  readonly maxOutputTokens?: number;
  readonly listenerTickIntervalMilliseconds?: number;
  readonly lockStaleAfterMilliseconds?: number;
  readonly recoverOnStart?: boolean;
  readonly shellRunner?: ShellProcessRunner;
  readonly now?: () => Date;
  readonly runId?: string;
}

export interface ProductKernel extends LiteKernelPort {
  readonly paths: LitePaths;
  readonly registry: ToolRegistry;
  runOnce(): Promise<LiteKernelTurnResult>;
  runLoop(signal: AbortSignal): Promise<void>;
  queryGoals(): Promise<readonly LiteGoalProjection[]>;
}

class ProductKernelImpl implements ProductKernel {
  readonly paths: LitePaths;
  readonly registry: ToolRegistry;
  private readonly runtime: LiteKernelRuntime;
  private readonly listener: ListenerLoop;
  private readonly options: ProductKernelOptions;
  private readonly taskStore: TaskStore;
  private readonly lock: LiteLock;
  private readonly recoverOnStart: boolean;

  constructor(input: {
    options: ProductKernelOptions;
    paths: LitePaths;
    registry: ToolRegistry;
    runtime: LiteKernelRuntime;
    listener: ListenerLoop;
    taskStore: TaskStore;
    lock: LiteLock;
  }) {
    this.options = input.options;
    this.paths = input.paths;
    this.registry = input.registry;
    this.runtime = input.runtime;
    this.listener = input.listener;
    this.taskStore = input.taskStore;
    this.lock = input.lock;
    this.recoverOnStart = input.options.recoverOnStart ?? true;
  }

  async start(): Promise<void> {
    const acquired = await this.lock.acquire({ allowStaleTakeover: true });
    if (!acquired.acquired) {
      throw new LiteError(
        "LITE_LOCK_HELD",
        `kernel is already running${acquired.holder === null ? "" : ` (pid ${acquired.holder.pid})`}`,
      );
    }
    try {
      if (this.recoverOnStart) {
        await recoverLiteState({
          paths: this.paths,
          ...(this.options.now === undefined ? {} : { now: this.options.now }),
        });
        await this.taskStore.load();
      }
      await this.runtime.start();
      this.listener.start();
    } catch (error) {
      await this.lock.release();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.listener.stop();
    await this.runtime.stop();
    await this.lock.release();
  }

  async pause(): Promise<void> {
    await this.runtime.pause();
  }

  async resume(): Promise<void> {
    await this.runtime.resume();
  }

  async submitUserMessage(input: LiteUserMessageInput): Promise<LiteUserMessageReceipt> {
    const receipt = await this.runtime.submitUserMessage(input);
    this.listener.wake();
    return receipt;
  }

  async withdrawUserMessage(messageId: string): Promise<boolean> {
    const result = await this.runtime.withdrawUserMessage(messageId);
    this.listener.wake();
    return result;
  }

  getSnapshot(): Promise<LiteKernelSnapshot> {
    return this.runtime.getSnapshot();
  }

  subscribe(listener: LiteEventListener): LiteEventSubscription {
    return this.runtime.subscribe(listener);
  }

  runOnce(): Promise<LiteKernelTurnResult> {
    return this.runtime.runOnce();
  }

  async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = await this.runOnce();
      if (result.outcome !== "idle") continue;
      const reason = await this.listener.waitForWorkOrTick();
      if (reason === "stopped" || signal.aborted) return;
    }
  }

  async queryGoals(): Promise<readonly LiteGoalProjection[]> {
    return projectGoals(this.taskStore.list());
  }
}

export async function createProductKernel(options: ProductKernelOptions): Promise<ProductKernel> {
  const paths = resolveLitePaths({
    stateDirectory: options.stateDirectory ?? ".astarray-lite",
    workspaceRootPath: options.workspaceRootPath,
  });
  const now = options.now ?? (() => new Date());
  const inbox = new UserInbox({ paths, now });
  const slot = new MessageSlot(inbox);
  const userTurn = new UserTurnController(slot);
  const taskStore = new TaskStore({
    sequenceStore: new TaskSequenceStore(paths),
    now,
  });
  await taskStore.load();
  const replyStore = new ReplyStore({
    paths,
    runId: options.runId ?? "run-1",
    now,
  });
  const registry = new ToolRegistry();
  registerFileTools(registry, { workspaceRoot: options.workspaceRootPath, stateRoot: paths.stateRoot, now });
  registerShellTool(registry, {
    workspaceRoot: options.workspaceRootPath,
    ...(options.shellRunner === undefined ? {} : { runner: options.shellRunner }),
  });
  registerReplyTools(registry, { workspaceRoot: options.workspaceRootPath, replyStore, messageSlot: slot });
  registerTaskTools(registry, { paths, taskStore, userTurn, now });

  const permissionManager = new PermissionManager({
    profile: options.profile ?? "balanced",
    now,
  });
  const hooks: ToolExecutionHooks = {
    authorize: (spec, argumentsValue) =>
      permissionManager.authorize({
        toolName: spec.name,
        capability: spec.capability,
        argumentsValue,
      }),
    requestApproval: async (spec, argumentsValue) => {
      if (options.approvalHandler === undefined) return false;
      const capability = spec.capability;
      const decision = await options.approvalHandler({
        toolName: spec.name,
        capability,
        safePreview: createSafePreview(spec.name, argumentsValue),
      });
      if (decision === "deny") return false;
      if (decision === "allow-session" && capability !== undefined) {
        permissionManager.grantSession(capability, spec.name, argumentsValue);
      }
      return true;
    },
  };
  const toolExecutor = new ToolExecutor({ registry, hooks });
  const runtime = new LiteKernelRuntime({
    stateDirectory: options.stateDirectory ?? ".astarray-lite",
    workspaceRootPath: options.workspaceRootPath,
    paths,
    provider: options.provider,
    registry,
    toolExecutor,
    inbox,
    messageSlot: slot,
    userTurn,
    taskStore,
    sessionId: options.sessionId,
    projectIdentifier: options.projectIdentifier,
    ...(options.systemPromptText === undefined ? {} : { systemPromptText: options.systemPromptText }),
    ...(options.systemPromptVersion === undefined ? {} : { systemPromptVersion: options.systemPromptVersion }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.listenerTickIntervalMilliseconds === undefined
      ? {}
      : { listenerTickIntervalMilliseconds: options.listenerTickIntervalMilliseconds }),
  });
  const listener = new ListenerLoop(options.listenerTickIntervalMilliseconds ?? 3_000);
  const lock = new LiteLock({
    lockFile: paths.lockFile,
    ...(options.lockStaleAfterMilliseconds === undefined
      ? {}
      : { staleAfterMilliseconds: options.lockStaleAfterMilliseconds }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return new ProductKernelImpl({ options, paths, registry, runtime, listener, taskStore, lock });
}
