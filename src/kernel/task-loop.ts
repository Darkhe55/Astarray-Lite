import {
  TurnArbiter,
  type LiteTurnDecision,
  type TurnArbiterInput,
} from "./turn-arbiter.js";

export interface TaskLoopRunInput extends TurnArbiterInput {
  readonly runUserTurn: () => Promise<void>;
  readonly runTaskTurn: () => Promise<void>;
}

/**
 * Executes exactly one turn chosen by the arbiter, then releases the
 * single-flight guard. The caller owns persistence and event emission inside
 * the two turn callbacks.
 */
export class TaskLoop {
  private readonly arbiter: TurnArbiter;

  constructor(arbiter: TurnArbiter = new TurnArbiter()) {
    this.arbiter = arbiter;
  }

  async runOnce(input: TaskLoopRunInput): Promise<LiteTurnDecision> {
    const decision = this.arbiter.decide(input);
    if (decision.kind === "idle") return decision;

    if (!this.arbiter.beginTurn()) {
      return { kind: "idle", reason: "turn-in-flight" };
    }

    try {
      if (decision.kind === "user") {
        await input.runUserTurn();
      } else {
        await input.runTaskTurn();
      }
    } finally {
      this.arbiter.endTurn();
    }

    return decision;
  }

  getArbiter(): TurnArbiter {
    return this.arbiter;
  }
}
