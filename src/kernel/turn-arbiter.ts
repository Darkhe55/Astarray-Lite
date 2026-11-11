export type LiteTurnDecision =
  | { readonly kind: "user" }
  | { readonly kind: "task" }
  | {
      readonly kind: "idle";
      readonly reason: "stopping" | "paused" | "turn-in-flight" | "no-work";
    };

export interface TurnArbiterInput {
  readonly hasActiveUserMessage: boolean;
  readonly hasRunnableTask: boolean;
  readonly isPaused: boolean;
  readonly isStopping: boolean;
}

/**
 * Chooses at most one turn. User messages always win over background tasks; a
 * paused/stopping kernel and an in-flight turn yield `idle`.
 */
export class TurnArbiter {
  private inFlight = false;

  decide(input: TurnArbiterInput): LiteTurnDecision {
    if (input.isStopping) return { kind: "idle", reason: "stopping" };
    if (input.isPaused) return { kind: "idle", reason: "paused" };
    if (this.inFlight) return { kind: "idle", reason: "turn-in-flight" };
    if (input.hasActiveUserMessage) return { kind: "user" };
    if (input.hasRunnableTask) return { kind: "task" };
    return { kind: "idle", reason: "no-work" };
  }

  beginTurn(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  endTurn(): void {
    this.inFlight = false;
  }

  hasTurnInFlight(): boolean {
    return this.inFlight;
  }
}
