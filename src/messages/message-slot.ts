import { LiteError } from "../contracts/errors.js";
import type {
  LiteUserMessage,
  LiteUserMessageDisposition,
} from "../inbox/user-message.js";
import type { UserInbox } from "../inbox/user-inbox.js";

/**
 * The single active-user-message slot. It wraps the inbox so tools cannot mark
 * or resolve a message that is not currently admitted.
 */
export class MessageSlot {
  private readonly inbox: UserInbox;

  constructor(inbox: UserInbox) {
    this.inbox = inbox;
  }

  async admitNext(): Promise<LiteUserMessage | null> {
    return this.inbox.admitNext();
  }

  getActive(): LiteUserMessage | null {
    return this.inbox.getActive();
  }

  async resolveActive(input: {
    readonly disposition: LiteUserMessageDisposition;
    readonly reason?: string;
    readonly createdTaskIds?: readonly string[];
    readonly turnId?: string;
  }): Promise<LiteUserMessage> {
    const active = this.getActive();
    if (active === null) {
      throw new LiteError("LITE_USER_MESSAGE_NOT_FOUND", "there is no active user message");
    }
    return this.inbox.resolve({
      messageId: active.messageId,
      disposition: input.disposition,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.createdTaskIds === undefined ? {} : { createdTaskIds: input.createdTaskIds }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });
  }

  async markNoise(reason: string): Promise<LiteUserMessage> {
    return this.resolveActive({ disposition: "noise", reason });
  }
}
