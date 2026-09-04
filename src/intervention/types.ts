import type { EvidenceReference } from "../surface/types.js";

export type ControlOwner = "automation" | "human";

export type InterventionRunState =
  | "RUNNING_AUTOMATION"
  | "INTERVENTION_REQUIRED"
  | "WAITING_FOR_HUMAN"
  | "HUMAN_CONTROL"
  | "RESUME_REQUESTED"
  | "VERIFYING_RESUME"
  | "COMPLETED"
  | "FAILED";

export type InterventionReason = "SESSION_EXPIRED" | "RISK_APPROVAL_REQUIRED" | "UNKNOWN_DIALOG" | "STUCK";

export type InterventionRequest = {
  id: string;
  runId: string;
  capabilityId?: string;
  currentStepId?: string;
  reason: InterventionReason;
  currentRoute: string;
  screenshot?: EvidenceReference;
  lastActionIds: string[];
  controlOwner: ControlOwner;
  createdAt: string;
};

export type HumanActionRecord = {
  actor: "human";
  action: "click" | "input" | "navigation";
  target: string;
  timestamp: string;
  redactedValue?: string;
};

export type OwnershipTransition = {
  from: ControlOwner;
  to: ControlOwner;
  state: InterventionRunState;
  timestamp: string;
};
