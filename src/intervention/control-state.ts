import type { ControlOwner, InterventionRunState, OwnershipTransition } from "./types.js";

export class ControlState {
  private owner: ControlOwner = "automation";
  private state: InterventionRunState = "RUNNING_AUTOMATION";
  private readonly transitions: OwnershipTransition[] = [];

  currentOwner(): ControlOwner {
    return this.owner;
  }

  currentState(): InterventionRunState {
    return this.state;
  }

  history(): OwnershipTransition[] {
    return [...this.transitions];
  }

  automationMayAct(): boolean {
    return this.owner === "automation" && ["RUNNING_AUTOMATION", "VERIFYING_RESUME"].includes(this.state);
  }

  assertAutomationMayAct(): void {
    if (!this.automationMayAct()) {
      throw new Error(`Automation cannot act while owner=${this.owner} state=${this.state}`);
    }
  }

  markInterventionRequired(): void {
    this.setState("INTERVENTION_REQUIRED");
  }

  waitForHuman(): void {
    this.setState("WAITING_FOR_HUMAN");
  }

  transferToHuman(): void {
    this.transition("human", "HUMAN_CONTROL");
  }

  requestResume(): void {
    if (this.owner !== "human") {
      throw new Error("Resume can only be requested while human owns the session");
    }
    this.setState("RESUME_REQUESTED");
  }

  verifyResume(): void {
    if (this.owner !== "human" || this.state !== "RESUME_REQUESTED") {
      throw new Error(`Cannot verify resume while owner=${this.owner} state=${this.state}`);
    }
    this.transition("automation", "VERIFYING_RESUME");
  }

  resumeAutomation(): void {
    if (this.owner !== "automation" || this.state !== "VERIFYING_RESUME") {
      throw new Error(`Cannot resume automation while owner=${this.owner} state=${this.state}`);
    }
    this.setState("RUNNING_AUTOMATION");
  }

  complete(): void {
    this.setState("COMPLETED");
  }

  fail(): void {
    this.setState("FAILED");
  }

  private setState(state: InterventionRunState): void {
    this.state = state;
  }

  private transition(to: ControlOwner, state: InterventionRunState): void {
    const from = this.owner;
    this.owner = to;
    this.state = state;
    this.transitions.push({
      from,
      to,
      state,
      timestamp: new Date().toISOString()
    });
  }
}
