import { describeLiteCapabilities } from "../contracts/capabilities.js";
import type { LiteCapabilityDescriptor } from "../contracts/capabilities.js";
import { LiteError } from "../contracts/errors.js";
import type {
  LiteApplicationFacade,
  LiteApplicationOptions,
  LiteSubmitTaskInput,
  LiteTaskResult,
} from "../contracts/facade.js";
import type {
  LiteEventListener,
  LiteEventSubscription,
} from "../contracts/events.js";
import type { LiteKernelSnapshot } from "../contracts/kernel-port.js";
import type { LiteGoalProjection } from "../facade/goal-projection.js";
import { validateLiteApplicationOptions } from "./options.js";

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

class LiteApplicationScaffold implements LiteApplicationFacade {
  private readonly listeners = new Set<LiteEventListener>();

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
    throw new LiteError(
      "LITE_NOT_IMPLEMENTED",
      "kernel runtime is not implemented yet (facade scaffold).",
    );
  }

  async cancelTask(input: {
    readonly sessionId: string;
    readonly taskIdentifier: string;
  }): Promise<void> {
    if (input.sessionId.trim() === "" || input.taskIdentifier.trim() === "") {
      throw new LiteError(
        "LITE_INVALID_ARGUMENT",
        "sessionId and taskIdentifier must be non-empty",
      );
    }
    throw new LiteError(
      "LITE_NOT_IMPLEMENTED",
      "kernel runtime is not implemented yet (facade scaffold).",
    );
  }

  async queryCapabilities(): Promise<LiteCapabilityDescriptor> {
    return describeLiteCapabilities();
  }

  async querySnapshot(): Promise<LiteKernelSnapshot> {
    throw new LiteError(
      "LITE_NOT_IMPLEMENTED",
      "kernel runtime is not implemented yet (facade scaffold).",
    );
  }

  async queryGoals(): Promise<readonly LiteGoalProjection[]> {
    return [];
  }
}

/**
 * Creates the public facade.
 *
 * The scaffold validates host options and exposes capability/event plumbing.
 * Kernel-backed operations fail closed until the runtime is wired.
 */
export async function createLiteApplication(
  options: LiteApplicationOptions,
): Promise<LiteApplicationFacade> {
  validateLiteApplicationOptions(options);
  return new LiteApplicationScaffold();
}
