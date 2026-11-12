import type { LiteEventListener, LiteEventSubscription } from "../contracts/events.js";
import type { LiteKernelSnapshot, LiteUserMessageReceipt } from "../contracts/kernel-port.js";
import type { LiteGoalProjection } from "../facade/goal-projection.js";
import { describeLiteCapabilities, type LiteCapabilityDescriptor } from "../contracts/capabilities.js";
import { projectGuiHistory, type GuiHistoryMessage } from "../facade/history-projection.js";
import { projectGuiTasks, type GuiTaskRow } from "../facade/gui-projection.js";
import type { ApprovalBroker, PendingApproval } from "./approval-broker.js";
import type { LiteApprovalDecision, ProductKernel } from "./product-kernel.js";

export interface GuiTaskInput {
  readonly sessionId: string;
  readonly taskIdentifier: string;
  readonly prompt: string;
  readonly idempotencyKey?: string;
}

export interface GuiTaskResult {
  readonly taskIdentifier: string;
  readonly status: LiteUserMessageReceipt["status"];
}

export interface ProductCapabilities extends LiteCapabilityDescriptor {
  readonly images: boolean;
  readonly documents: boolean;
  readonly approvals: boolean;
}

export interface ProductGuiPort {
  subscribe(listener: LiteEventListener): LiteEventSubscription;
  submitTask(input: GuiTaskInput): Promise<GuiTaskResult>;
  cancelTask(input: { readonly sessionId: string; readonly taskIdentifier: string }): Promise<boolean>;
  queryCapabilities(): Promise<ProductCapabilities>;
  querySnapshot(): Promise<LiteKernelSnapshot>;
  queryGoals(): Promise<readonly LiteGoalProjection[]>;
  queryHistory(limit?: number): Promise<readonly GuiHistoryMessage[]>;
  queryTasks(): Promise<readonly GuiTaskRow[]>;
  queryApprovals(): readonly PendingApproval[];
  resolveApproval(id: string, decision: LiteApprovalDecision): boolean;
}

/**
 * Thin adapter from the product kernel to the desktop GUI port. It owns only
 * task-id mapping and approval exposure; all execution stays in the kernel.
 */
export class ProductGuiAdapter implements ProductGuiPort {
  private readonly kernel: ProductKernel;
  private readonly approvals: ApprovalBroker | undefined;
  private readonly taskMessages = new Map<string, string>();

  constructor(options: { readonly kernel: ProductKernel; readonly approvals?: ApprovalBroker }) {
    this.kernel = options.kernel;
    this.approvals = options.approvals;
  }

  subscribe(listener: LiteEventListener): LiteEventSubscription {
    return this.kernel.subscribe(listener);
  }

  async submitTask(input: GuiTaskInput): Promise<GuiTaskResult> {
    if (this.taskMessages.has(input.taskIdentifier)) {
      return { taskIdentifier: input.taskIdentifier, status: "queued" };
    }
    const receipt = await this.kernel.submitUserMessage({
      text: input.prompt,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    this.taskMessages.set(input.taskIdentifier, receipt.messageId);
    return { taskIdentifier: input.taskIdentifier, status: receipt.status };
  }

  async cancelTask(input: {
    readonly sessionId: string;
    readonly taskIdentifier: string;
  }): Promise<boolean> {
    const messageId = this.taskMessages.get(input.taskIdentifier);
    if (messageId === undefined) return false;
    const withdrawn = await this.kernel.withdrawUserMessage(messageId);
    if (withdrawn) this.taskMessages.delete(input.taskIdentifier);
    return withdrawn;
  }

  async queryCapabilities(): Promise<ProductCapabilities> {
    const features = this.kernel.describeFeatures();
    return {
      ...describeLiteCapabilities(),
      images: features.images,
      documents: features.documents,
      approvals: this.approvals !== undefined,
    };
  }

  querySnapshot(): Promise<LiteKernelSnapshot> {
    return this.kernel.getSnapshot();
  }

  queryGoals(): Promise<readonly LiteGoalProjection[]> {
    return this.kernel.queryGoals();
  }

  async queryHistory(limit = 50): Promise<readonly GuiHistoryMessage[]> {
    return projectGuiHistory(await this.kernel.queryHistory(limit));
  }

  async queryTasks(): Promise<readonly GuiTaskRow[]> {
    return projectGuiTasks(await this.kernel.queryTasks());
  }

  queryApprovals(): readonly PendingApproval[] {
    return this.approvals?.list() ?? [];
  }

  resolveApproval(id: string, decision: LiteApprovalDecision): boolean {
    return this.approvals?.resolve(id, decision) ?? false;
  }
}
