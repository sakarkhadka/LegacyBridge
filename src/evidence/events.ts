import type { AgentDecision } from "../discovery/decision-schema.js";
import type { HumanActionRecord, InterventionRequest, OwnershipTransition } from "../intervention/types.js";
import type { PolicyDecision } from "../policy/types.js";
import type { ExecutionResult } from "../replay/results.js";
import type { ActionResult, ResolvedTarget, SurfaceObservation } from "../surface/types.js";

export type EvidenceEventName =
  | "run_started"
  | "authentication_completed"
  | "observation_captured"
  | "model_decision"
  | "policy_checked"
  | "target_resolved"
  | "step_started"
  | "action_completed"
  | "business_outcome_detected"
  | "recovery_attempted"
  | "checkpoint_passed"
  | "intervention_created"
  | "control_transferred"
  | "human_action"
  | "automation_resumed"
  | "run_completed"
  | "run_failed";

export type EvidenceEvent = {
  event: EvidenceEventName;
  timestamp: string;
  runId: string;
  capabilityId?: string;
  stepId?: string;
  data?: EvidencePayload;
};

export type EvidencePayload =
  | Record<string, unknown>
  | {
      observation: SurfaceObservation;
    }
  | {
      decision: AgentDecision;
    }
  | {
      policy: PolicyDecision;
    }
  | {
      target: ResolvedTarget;
    }
  | {
      action: ActionResult;
    }
  | {
      result: ExecutionResult;
    }
  | {
      intervention: InterventionRequest;
    }
  | {
      transition: OwnershipTransition;
    }
  | {
      humanAction: HumanActionRecord;
    };
