import type { CapabilityStep, InputDefinition, ValueSource } from "../artifact/types.js";
import type { AgentDecision } from "./decision-schema.js";

export type ParameterizationResult = {
  inputs: Record<string, InputDefinition>;
  sensitiveValues: string[];
};

const memberIdPattern = "\\b[0-9]{5}\\b";

export function parameterizationFromDiscovery(goal: string, decisions: AgentDecision[]): ParameterizationResult {
  const sensitiveValues = new Set<string>();
  const fromGoal = goal.match(new RegExp(memberIdPattern))?.[0];
  if (fromGoal) {
    sensitiveValues.add(fromGoal);
  }

  for (const decision of decisions) {
    if (decision.type === "act" && decision.action.type === "fill" && typeof decision.action.value === "string") {
      const value = decision.action.value.match(new RegExp(`^${memberIdPattern.slice(2, -2)}$`))?.[0];
      if (value) {
        sensitiveValues.add(value);
      }
    }
  }

  return {
    inputs: {
      memberId: {
        type: "string",
        required: true,
        sensitive: true,
        description: "Synthetic member number.",
        pattern: "^[0-9]{5}$"
      }
    },
    sensitiveValues: [...sensitiveValues]
  };
}

export function parameterizeStepValue(value: unknown, parameters: ParameterizationResult): ValueSource | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && parameters.sensitiveValues.includes(value)) {
    return {
      parameter: "memberId"
    };
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return {
      literal: value
    };
  }

  return undefined;
}

export function serializedArtifactContainsSensitiveValue(artifactYaml: string, parameters: ParameterizationResult): boolean {
  return parameters.sensitiveValues.some((value) => artifactYaml.includes(value));
}

export function stepUsesMemberParameter(step: CapabilityStep): boolean {
  return Boolean(step.value && "parameter" in step.value && step.value.parameter === "memberId");
}
