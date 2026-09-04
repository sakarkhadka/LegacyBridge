import type { StepAction } from "../artifact/types.js";
import type { FailureClass } from "../replay/errors.js";

export type RiskClassification = "READ_ONLY" | "REVERSIBLE_WRITE" | "IRREVERSIBLE_WRITE";

export type PolicyConfig = {
  allowedOrigins: string[];
  allowedRoutes: string[];
  allowedActions: StepAction[];
  irreversibleActionsRequireHuman: boolean;
};

export type PolicyCheckRequest = {
  origin: string;
  route: string;
  action: StepAction;
  risk: RiskClassification;
  actionRisk?: RiskClassification;
  approvalGranted?: boolean;
};

export type PolicyDecision =
  | {
      status: "allowed";
    }
  | {
      status: "requires_human_approval";
      reason: string;
    }
  | {
      status: "blocked";
      reason: string;
      failureClass: Extract<FailureClass, "POLICY_VIOLATION">;
    };
