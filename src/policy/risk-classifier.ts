import type { CapabilityStep } from "../artifact/types.js";
import type { RiskClassification } from "./types.js";

export function classifyStepRisk(step: CapabilityStep, capabilityRisk: RiskClassification): RiskClassification {
  if (step.risk) {
    return step.risk;
  }

  if (step.action === "extract" || step.action === "wait" || step.action === "navigate") {
    return "READ_ONLY";
  }

  if (step.action === "fill" || step.action === "select" || step.action === "click") {
    return capabilityRisk === "REVERSIBLE_WRITE" ? "REVERSIBLE_WRITE" : "READ_ONLY";
  }

  return capabilityRisk;
}
