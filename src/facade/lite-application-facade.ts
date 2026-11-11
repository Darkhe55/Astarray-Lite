import { describeLiteCapabilities } from "../contracts/capabilities.js";
import { LiteError } from "../contracts/errors.js";
import type {
  LiteApplicationFacade,
  LiteApplicationOptions,
  LiteSubmitTaskInput,
  LiteTaskResult,
} from "../contracts/facade.js";
import type {
  LiteEvent,
  LiteEventListener,
  LiteEventSubscription,
} from "../contracts/events.js";
import type { LiteKernelSnapshot } from "../contracts/kernel-port.js";
import type { LiteGoalProjection } from "./goal-projection.js";
import { validateLiteApplicationOptions } from "../application/options.js";

interface StoredTask {
  readonly result: LiteTaskResult;
  readonly idempotencyKey: string | undefined;
}

function assertSubmitInput(input: LiteSubmitTaskInput): void {
  if (input.sessionId.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "sessionId must be non-empty");
  }
  if (input.taskIdentifier.trim() === "") {
    throw new LiteError("LITE_INVALID_ARGUMENT", "taskIdentifier must be non-empty");
  }
  if (input.prompt.trim() === "") {
    throw new LiteError("LITE_USER_MESSAGE_EMPTY", "prompt must be non-empty");
  }
}

/**
 * Facade implementation for the in-process lite application. It keeps the
 * public envelope compatible while the full kernel runtime is assembled: task
 * submission is queued, cancellation is explicit, and events carry a monotonic
 * revision plus the submit idempotency id.
 */
class LiteFacadeApplication implements LiteApplicationFacade {
  private readonly options: LiteApplicationOptions;
  private readonly listeners = new Set<LiteEventListener>();
  private readonly tasks = new Map<string, StoredTask>();
  private readonly idempotency = new Map<string, string>();
  private revision = 0;

  constructor(options: LiteApplicationOptions) {
    this.options = options;
  }

  subscribe(listener: LiteEventListener): LiteEventSubscription {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async submitTask(input: LiteSubmitTaskInput): Promise<LiteTaskResult> {
    assertSubmitInput(input);
    if (input.idempotencyKey !== undefined) {
      const existingId = this.idempotency.get(input.idempotencyKey);
      const existing = existingId === undefined ? undefined : this.tasks.get(existingId);
      if (existing !== undefined) return existing.result;
    }

    const result: LiteTaskResult = {
      taskIdentifier: input.taskIdentifier,
      missionIdentifier: null,
      status: "queued",
      summaryPreview: input.prompt.slice(0, 200),
    };
    this.tasks.set(input.taskIdentifier, {
      result,
      idempotencyKey: input.idempotencyKey,
    });
    if (input.idempotencyKey !== undefined) {
      this.idempotency.set(input.idempotencyKey, input.taskIdentifier);
    }
    this.emit(
      {
        type: "task.created",
        atIso: new Date().toISOString(),
        taskId: input.taskIdentifier,
        taskKind: "normal",
      },
      input.idempotencyKey,
    );
    return result;
  }

  async cancelTask(input: {
    readonly sessionId: string;
    readonly taskIdentifier: string;
  }): Promise<void> {
    if (input.sessionId.trim() === "" || input.taskIdentifier.trim() === "") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "sessionId and taskIdentifier must be non-empty");
    }
    const stored = this.tasks.get(input.taskIdentifier);
    if (stored === undefined) {
      throw new LiteError("LITE_TASK_NOT_FOUND", "task not found");
    }
    if (stored.result.status === "cancelled" || stored.result.status === "done") return;
    this.tasks.set(input.taskIdentifier, {
      result: { ...stored.result, status: "cancelled" },
      idempotencyKey: stored.idempotencyKey,
    });
    this.emit(
      {
        type: "task.archived",
        atIso: new Date().toISOString(),
        taskId: input.taskIdentifier,
        disposition: "cancelled",
      },
      stored.idempotencyKey,
    );
  }

  async queryCapabilities(): Promise<ReturnType<typeof describeLiteCapabilities>> {
    return describeLiteCapabilities();
  }

  async querySnapshot(): Promise<LiteKernelSnapshot> {
    const values = [...this.tasks.values()];
    return {
      schemaVersion: 1,
      kernel: "lite",
      sessionId: this.options.sessionId ?? "lite-session",
      projectIdentifier: this.options.projectIdentifier ?? "lite-project",
      status: "idle",
      activeUserMessageId: null,
      activeTaskId: null,
      pendingTaskCount: values.filter((entry) => entry.result.status === "queued").length,
      goalCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      updatedAtIso: new Date().toISOString(),
    };
  }

  async queryGoals(): Promise<readonly LiteGoalProjection[]> {
    return [];
  }

  private emit(event: LiteEvent, idempotencyId: string | undefined): void {
    this.revision += 1;
    const envelope: LiteEvent = {
      ...event,
      revision: this.revision,
      ...(idempotencyId === undefined ? {} : { idempotencyId }),
    };
    for (const listener of this.listeners) {
      listener(envelope);
    }
  }
}

export async function createLiteFacadeApplication(
  options: LiteApplicationOptions,
): Promise<LiteApplicationFacade> {
  validateLiteApplicationOptions(options);
  return new LiteFacadeApplication(options);
}
