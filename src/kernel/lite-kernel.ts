import { LiteError } from "../contracts/errors.js";
import { promises as fs } from "node:fs";
import type { LiteEventListener, LiteEventSubscription } from "../contracts/events.js";
import type {
  LiteKernelOptions,
  LiteKernelPort,
  LiteKernelSnapshot,
  LiteUserMessageInput,
  LiteUserMessageReceipt,
} from "../contracts/kernel-port.js";
import { assembleContext } from "../context/context-assembler.js";
import { estimateTokens } from "../context/token-budget.js";
import type { UserInbox } from "../inbox/user-inbox.js";
import type { MessageSlot } from "../messages/message-slot.js";
import type { ReplyStore } from "../messages/reply-store.js";
import type { UserTurnController } from "../messages/user-turn.js";
import type { LitePaths } from "../persistence/lite-paths.js";
import { ProviderTurnRunner, type ProviderTurnOutcome } from "../runtime/provider-turn-runner.js";
import type { LiteProvider, LiteProviderContentPart } from "../runtime/provider.js";
import type { TaskStore } from "../tasks/task-store.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolExecutor } from "../tools/tool-executor.js";
import { resolveWorkspacePath } from "../tools/builtin/path-safety.js";

export interface LiteKernelRuntimeOptions extends LiteKernelOptions {
  readonly sessionId: string;
  readonly projectIdentifier: string;
  readonly paths: LitePaths;
  readonly provider: LiteProvider;
  readonly registry: ToolRegistry;
  readonly toolExecutor: ToolExecutor;
  readonly inbox: UserInbox;
  readonly messageSlot: MessageSlot;
  readonly userTurn: UserTurnController;
  readonly replyStore?: ReplyStore;
  readonly taskStore?: TaskStore;
  readonly systemPromptVersion?: string;
  readonly systemPromptText?: string;
  readonly maxOutputTokens?: number;
}

export interface LiteKernelTurnResult {
  readonly outcome: ProviderTurnOutcome | "idle";
  readonly text: string;
  readonly toolCallCount: number;
  readonly errorCode?: string;
}

type RuntimeStatus = "booting" | "idle" | "running" | "paused" | "stopped";

/**
 * Minimal in-process kernel loop. It wires the turn arbiter's inputs (one
 * active user message), context assembly, provider calls, the tool executor
 * and user-message resolution. The background listener can call `runOnce`
 * repeatedly; no provider request is made when there is no admitted work.
 */
export class LiteKernelRuntime implements LiteKernelPort {
  private readonly options: LiteKernelRuntimeOptions;
  private readonly listeners = new Set<LiteEventListener>();
  private status: RuntimeStatus = "booting";

  constructor(options: LiteKernelRuntimeOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.status === "stopped") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "kernel is stopped");
    }
    this.status = "idle";
    this.emit({
      type: "kernel.started",
      atIso: new Date().toISOString(),
      sessionId: this.options.sessionId,
      kernelVersion: "0.0.0",
    });
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    this.emit({ type: "kernel.stopped", atIso: new Date().toISOString(), reason: "user" });
  }

  async pause(): Promise<void> {
    if (this.status !== "stopped") this.status = "paused";
  }

  async resume(): Promise<void> {
    if (this.status === "paused") this.status = "idle";
  }

  async submitUserMessage(input: LiteUserMessageInput): Promise<LiteUserMessageReceipt> {
    if (this.status === "stopped") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "kernel is stopped");
    }
    const message = await this.options.inbox.enqueue({
      text: input.text,
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    this.emit({
      type: "user-message.enqueued",
      atIso: new Date().toISOString(),
      messageId: message.messageId,
    });
    return {
      messageId: message.messageId,
      status: "queued",
      receivedAtIso: message.receivedAtIso,
    };
  }

  async withdrawUserMessage(messageId: string): Promise<boolean> {
    return this.options.inbox.withdraw(messageId);
  }

  async getSnapshot(): Promise<LiteKernelSnapshot> {
    const activeUser = this.options.messageSlot.getActive();
    const tasks = this.options.taskStore?.list() ?? [];
    return {
      schemaVersion: 1,
      kernel: "lite",
      sessionId: this.options.sessionId,
      projectIdentifier: this.options.projectIdentifier ?? "lite-project",
      status:
        this.status === "booting"
          ? "booting"
          : this.status === "running"
            ? "running"
            : this.status === "paused"
              ? "paused"
              : this.status === "stopped"
                ? "stopped"
                : "idle",
      activeUserMessageId: activeUser?.messageId ?? null,
      activeTaskId: this.options.taskStore?.getSequence().activeTaskId ?? null,
      pendingTaskCount: this.options.taskStore?.getSequence().pendingTaskIds.length ?? 0,
      goalCount: tasks.filter((task) => task.taskKind === "goal").length,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      updatedAtIso: new Date().toISOString(),
    };
  }

  subscribe(listener: LiteEventListener): LiteEventSubscription {
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  async runOnce(): Promise<LiteKernelTurnResult> {
    if (this.status === "paused" || this.status === "stopped") {
      return { outcome: "idle", text: "", toolCallCount: 0 };
    }
    let active = this.options.messageSlot.getActive();
    if (active === null) {
      active = await this.options.userTurn.admitNext();
    }
    if (active === null) return { outcome: "idle", text: "", toolCallCount: 0 };

    this.status = "running";
    const turnId = `trn_${Date.now()}`;
    this.emit({ type: "turn.started", atIso: new Date().toISOString(), turnId, kind: "user" });
    try {
      const tools = this.options.registry.getContextDefinitions();
      const assembled = assembleContext({
        promptVersion: this.options.systemPromptVersion ?? "lite-1.0",
        promptText: this.options.systemPromptText ?? "You are the Astarray Lite single-agent kernel.",
        toolsetRevision: this.options.registry.getRevision(),
        tools,
        user: {
          messageId: active.messageId,
          text: active.text,
          attachments: active.attachments.map((attachment) => attachment.path),
        },
      });
      this.emit({
        type: "context.assembled",
        atIso: new Date().toISOString(),
        turnId,
        prefixHash: assembled.prefixHash,
        tokenCount: assembled.blocks.reduce(
          (total, block) => total + estimateTokens(block.serializedContent),
          0,
        ),
        cacheClass: "stable",
      });

      const runner = new ProviderTurnRunner();
      const contentParts = await this.buildContentParts(active);
      const result = await runner.run({
        provider: this.options.provider,
        messages: [
          { role: "system", content: this.options.systemPromptText ?? "You are the Astarray Lite single-agent kernel." },
          {
            role: "user",
            content: active.text,
            ...(contentParts === undefined ? {} : { contentParts }),
          },
        ],
        tools,
        maxOutputTokens: this.options.maxOutputTokens ?? 4_096,
        executeTool: async (call, signal) => {
          const executed = await this.options.toolExecutor.execute({
            callId: call.callId,
            toolName: call.toolName,
            argumentsJson: call.argumentsJson,
            ...(signal === undefined ? {} : { signal }),
          });
          return {
            callId: call.callId,
            toolName: call.toolName,
            outputText: executed.outputText || executed.errorMessage || "",
            isError: !executed.ok,
          };
        },
      });

      if (this.options.messageSlot.getActive() !== null && result.text.trim() !== "") {
        this.options.userTurn.recordReply(result.text);
        await this.options.replyStore?.appendReply({
          text: result.text,
          attachments: [],
          resolvesActiveUserMessage: true,
        });
        await this.options.userTurn.finalize();
      }
      this.emit({
        type: "turn.finished",
        atIso: new Date().toISOString(),
        turnId,
        outcome: result.outcome === "completed" ? "completed" : "failed",
        durationMs: 0,
      });
      return {
        outcome: result.outcome,
        text: result.text,
        toolCallCount: result.toolCalls.length,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      };
    } catch (error) {
      const code = error instanceof LiteError ? error.code : "LITE_INTERNAL_ERROR";
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", atIso: new Date().toISOString(), code, message });
      return { outcome: "error", text: "", toolCallCount: 0, errorCode: code };
    } finally {
      if (this.status === "running") this.status = "idle";
    }
  }

  private async buildContentParts(active: {
    readonly text: string;
    readonly attachments: readonly { readonly path: string; readonly mediaType: string }[];
  }): Promise<readonly LiteProviderContentPart[] | undefined> {
    const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const images: LiteProviderContentPart[] = [];
    for (const attachment of active.attachments) {
      if (!supported.has(attachment.mediaType.toLowerCase())) continue;
      try {
        const absolutePath = await resolveWorkspacePath({
          workspaceRoot: this.options.paths.workspaceRoot,
          relativePath: attachment.path,
        });
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
        const data = await fs.readFile(absolutePath);
        images.push({
          type: "image",
          mediaType: attachment.mediaType.toLowerCase(),
          dataBase64: data.toString("base64"),
        });
      } catch {
        // A missing or unsafe attachment is omitted rather than failing the turn.
      }
    }
    return images.length === 0 ? undefined : [{ type: "text", text: active.text }, ...images];
  }

  private emit(event: Parameters<LiteEventListener>[0]): void {
    for (const listener of this.listeners) listener(event);
  }
}
