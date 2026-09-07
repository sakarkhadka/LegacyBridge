import type { ConditionDefinition } from "../artifact/types.js";
import { conditionsPass, type ConditionContext } from "../replay/checkpoint-engine.js";
import type { SurfaceAdapter } from "../surface/types.js";
import { ControlState } from "./control-state.js";
import { HumanEventRecorder } from "./human-event-recorder.js";
import type { HumanActionRecord, InterventionReason, InterventionRequest, OwnershipTransition } from "./types.js";

export type TriggerInterventionOptions = {
  runId: string;
  capabilityId?: string;
  currentStepId?: string;
  reason: InterventionReason;
  currentRoute: string;
  lastActionIds: string[];
  surface: SurfaceAdapter;
};

export type ManualInterventionOptions = Omit<TriggerInterventionOptions, "surface"> & {
  screenshot?: InterventionRequest["screenshot"];
};

export type ResumeVerificationResult = {
  ok: boolean;
  state: string;
};

export class InterventionManager {
  private active?: InterventionRequest;
  readonly controlState = new ControlState();
  readonly humanEvents: HumanEventRecorder;

  constructor(options: { sensitiveValues?: string[] } = {}) {
    this.humanEvents = new HumanEventRecorder(options.sensitiveValues ?? []);
  }

  async trigger(options: TriggerInterventionOptions): Promise<InterventionRequest> {
    this.controlState.markInterventionRequired();
    const screenshot = await options.surface.captureEvidence().catch(() => undefined);
    return this.createIntervention({
      ...options,
      screenshot
    });
  }

  triggerManual(options: ManualInterventionOptions): InterventionRequest {
    this.controlState.markInterventionRequired();
    return this.createIntervention(options);
  }

  private createIntervention(options: ManualInterventionOptions): InterventionRequest {
    this.active = {
      id: `int-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      runId: options.runId,
      capabilityId: options.capabilityId,
      currentStepId: options.currentStepId,
      reason: options.reason,
      currentRoute: options.currentRoute,
      screenshot: options.screenshot,
      lastActionIds: options.lastActionIds,
      controlOwner: "automation",
      createdAt: new Date().toISOString()
    };
    this.controlState.waitForHuman();
    return this.active;
  }

  takeHumanControl(): InterventionRequest {
    this.ensureActive();
    this.controlState.transferToHuman();
    this.syncOwner();
    return this.active!;
  }

  recordHumanClick(target: string): HumanActionRecord {
    this.assertHumanControl();
    return this.humanEvents.recordClick(target);
  }

  recordHumanInput(target: string, value: string): HumanActionRecord {
    this.assertHumanControl();
    return this.humanEvents.recordInput(target, value);
  }

  recordHumanNavigation(target: string): HumanActionRecord {
    this.assertHumanControl();
    return this.humanEvents.recordNavigation(target);
  }

  requestResume(): InterventionRequest {
    this.assertHumanControl();
    this.controlState.requestResume();
    this.syncOwner();
    return this.active!;
  }

  async verifyResume(conditions: ConditionDefinition[], context: ConditionContext): Promise<ResumeVerificationResult> {
    this.ensureActive();
    this.controlState.verifyResume();
    this.syncOwner();
    const ok = await conditionsPass(conditions, context);
    if (!ok) {
      this.controlState.fail();
      return {
        ok: false,
        state: this.controlState.currentState()
      };
    }
    this.controlState.resumeAutomation();
    return {
      ok: true,
      state: this.controlState.currentState()
    };
  }

  complete(): void {
    this.controlState.complete();
  }

  assertAutomationMayAct(): void {
    this.controlState.assertAutomationMayAct();
  }

  currentIntervention(): InterventionRequest | undefined {
    return this.active ? { ...this.active } : undefined;
  }

  evidence(): {
    intervention?: InterventionRequest;
    humanActions: HumanActionRecord[];
    ownershipTransitions: OwnershipTransition[];
  } {
    return {
      intervention: this.currentIntervention(),
      humanActions: this.humanEvents.list(),
      ownershipTransitions: this.controlState.history()
    };
  }

  private assertHumanControl(): void {
    this.ensureActive();
    if (this.controlState.currentOwner() !== "human") {
      throw new Error("Human action can only be recorded while human owns the session");
    }
  }

  private ensureActive(): void {
    if (!this.active) {
      throw new Error("No active intervention");
    }
  }

  private syncOwner(): void {
    if (this.active) {
      this.active = {
        ...this.active,
        controlOwner: this.controlState.currentOwner()
      };
    }
  }
}
