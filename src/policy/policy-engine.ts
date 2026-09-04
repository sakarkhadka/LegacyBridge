import type { StepAction } from "../artifact/types.js";
import type { PolicyCheckRequest, PolicyConfig, PolicyDecision, RiskClassification } from "./types.js";

export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  check(request: PolicyCheckRequest): PolicyDecision {
    if (!this.config.allowedActions.includes(request.action)) {
      return blocked(`action ${request.action} is not allowlisted`);
    }

    if (!this.config.allowedOrigins.includes(request.origin)) {
      return blocked(`origin ${request.origin} is not allowlisted`);
    }

    if (!this.config.allowedRoutes.some((routePattern) => routeMatches(routePattern, request.route))) {
      return blocked(`route ${request.route} is not allowlisted`);
    }

    const effectiveRisk = highestRisk(request.risk, request.actionRisk ?? request.risk);
    if (effectiveRisk === "IRREVERSIBLE_WRITE" && this.config.irreversibleActionsRequireHuman && !request.approvalGranted) {
      return {
        status: "requires_human_approval",
        reason: "irreversible write requires human approval"
      };
    }

    return {
      status: "allowed"
    };
  }
}

export function routeMatches(pattern: string, pathname: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(pathname);
}

function blocked(reason: string): PolicyDecision {
  return {
    status: "blocked",
    reason,
    failureClass: "POLICY_VIOLATION"
  };
}

function highestRisk(a: RiskClassification, b: RiskClassification): RiskClassification {
  const order: Record<RiskClassification, number> = {
    READ_ONLY: 0,
    REVERSIBLE_WRITE: 1,
    IRREVERSIBLE_WRITE: 2
  };

  return order[a] >= order[b] ? a : b;
}

export function policyRequestForUrl(options: {
  url: URL;
  action: StepAction;
  capabilityRisk: RiskClassification;
  actionRisk?: RiskClassification;
  approvalGranted?: boolean;
}): PolicyCheckRequest {
  return {
    origin: options.url.origin,
    route: options.url.pathname,
    action: options.action,
    risk: options.capabilityRisk,
    actionRisk: options.actionRisk,
    approvalGranted: options.approvalGranted
  };
}

