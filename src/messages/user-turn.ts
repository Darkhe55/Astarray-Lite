import { LiteError } from "../contracts/errors.js";
import type { LiteUserMessage } from "../inbox/user-message.js";
import type { MessageSlot } from "../messages/message-slot.js";

export type LiteUserTurnAction =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "noise"; readonly reason: string }
  | { readonly kind: "task"; readonly taskIds: readonly string[] };

/**
 * Owns exactly one admitted user message and its atomic resolution.
 *
 * A turn may reply and create tasks at the same time; task creation wins the
 * disposition (`converted-to-task`). Noise cannot be combined with any other
 * action. No action leaves the message admitted, so the next turn can continue.
 */
export class UserTurnController {
  private readonly slot: MessageSlot;
  private admitted: LiteUserMessage | null = null;
  private actions: LiteUserTurnAction[] = [];

  constructor(slot: MessageSlot) {
    this.slot = slot;
  }

  async admitNext(): Promise<LiteUserMessage | null> {
    const active = this.slot.getActive();
    if (active !== null) {
      this.admitted = active;
      return active;
    }
    const next = await this.slot.admitNext();
    this.admitted = next;
    this.actions = [];
    return next;
  }

  getActive(): LiteUserMessage | null {
    return this.admitted === null ? this.slot.getActive() : this.admitted;
  }

  recordReply(text: string): void {
    this.requireAdmitted();
    if (text.trim() === "") {
      throw new LiteError("LITE_INVALID_ARGUMENT", "reply text must be non-empty");
    }
    this.actions.push({ kind: "reply", text });
  }

  recordNoise(reason: string): void {
    this.requireAdmitted();
    if (reason.trim().length < 5) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "noise reason must be at least 5 characters");
    }
    this.actions.push({ kind: "noise", reason: reason.trim() });
  }

  recordTaskCreation(taskIds: readonly string[]): void {
    this.requireAdmitted();
    const unique = [...new Set(taskIds)];
    if (unique.length === 0 || unique.some((taskId) => taskId.trim() === "")) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "task creation requires at least one task id");
    }
    this.actions.push({ kind: "task", taskIds: unique });
  }

  hasRecordedActions(): boolean {
    return this.actions.length > 0;
  }

  async finalize(): Promise<LiteUserMessage | null> {
    if (this.admitted === null) return null;
    const noise = this.actions.find((action) => action.kind === "noise");
    const replied = this.actions.some((action) => action.kind === "reply");
    const taskIds = this.actions
      .filter((action): action is Extract<LiteUserTurnAction, { kind: "task" }> => action.kind === "task")
      .flatMap((action) => action.taskIds);

    if (noise !== undefined && (replied || taskIds.length > 0)) {
      throw new LiteError("LITE_INVALID_ARGUMENT", "noise cannot be combined with a reply or task creation");
    }

    if (taskIds.length > 0) {
      const resolved = await this.slot.resolveActive({
        disposition: "converted-to-task",
        reason: "task-created",
        createdTaskIds: taskIds,
      });
      this.clear();
      return resolved;
    }
    if (replied) {
      const resolved = await this.slot.resolveActive({
        disposition: "answered",
        reason: "reply_user",
      });
      this.clear();
      return resolved;
    }
    if (noise !== undefined) {
      const resolved = await this.slot.resolveActive({
        disposition: "noise",
        reason: noise.reason,
      });
      this.clear();
      return resolved;
    }

    return this.admitted;
  }

  reset(): void {
    this.admitted = null;
    this.actions = [];
  }

  private requireAdmitted(): void {
    if (this.admitted === null) {
      throw new LiteError("LITE_USER_MESSAGE_NOT_FOUND", "no user message is admitted");
    }
  }

  private clear(): void {
    this.admitted = null;
    this.actions = [];
  }
}
