import type { CapabilityStep, InputDefinition, ValueSource } from "../artifact/types.js";
import type { AgentDecision } from "./decision-schema.js";

export type ParameterizationResult = {
  inputs: Record<string, InputDefinition>;
  sensitiveValues: string[];
  valuesByParameter: Record<string, string>;
};

const memberIdPattern = "\\b[0-9]{5}\\b";
const accountNumberPattern = "\\b[A-Z]-[0-9]{6}\\b";
const amountPattern = "^[0-9]+(\\.[0-9]{1,2})?$";

export function parameterizationFromDiscovery(goal: string, decisions: AgentDecision[]): ParameterizationResult {
  const valuesByParameter = new Map<string, string>();
  const sensitiveValues = new Set<string>();
  const fromGoal = goal.match(new RegExp(memberIdPattern))?.[0];
  if (fromGoal) {
    valuesByParameter.set("memberId", fromGoal);
    sensitiveValues.add(fromGoal);
  }
  const accountNumberFromGoal = goal.match(new RegExp(accountNumberPattern))?.[0];
  if (accountNumberFromGoal) {
    valuesByParameter.set("accountNumber", accountNumberFromGoal);
    sensitiveValues.add(accountNumberFromGoal);
  }

  for (const decision of decisions) {
    if (decision.type === "act" && decision.action.type === "fill" && typeof decision.action.value === "string") {
      const value = decision.action.value;
      if (new RegExp(`^${memberIdPattern.slice(2, -2)}$`).test(value)) {
        valuesByParameter.set("memberId", value);
        sensitiveValues.add(value);
      } else if (new RegExp(`^${accountNumberPattern.slice(2, -2)}$`).test(value)) {
        valuesByParameter.set("accountNumber", value);
        sensitiveValues.add(value);
      } else if (new RegExp(amountPattern).test(value)) {
        valuesByParameter.set("amount", value);
      }
    }
  }

  const inputs: Record<string, InputDefinition> = {
    memberId: {
      type: "string",
      required: true,
      sensitive: true,
      description: "Synthetic member number.",
      pattern: "^[0-9]{5}$"
    }
  };

  if (valuesByParameter.has("accountNumber")) {
    inputs.accountNumber = {
      type: "string",
      required: true,
      sensitive: true,
      description: "Exact account number.",
      pattern: "^[A-Z]-[0-9]{6}$"
    };
  }

  if (valuesByParameter.has("amount")) {
    inputs.amount = {
      type: "string",
      required: true,
      description: "Positive dollar amount.",
      pattern: "^[0-9]+(\\.[0-9]{1,2})?$"
    };
  }

  return {
    inputs,
    sensitiveValues: [...sensitiveValues],
    valuesByParameter: Object.fromEntries(valuesByParameter)
  };
}

export function parameterizeStepValue(value: unknown, parameters: ParameterizationResult): ValueSource | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const parameter = parameterForLiteral(value, parameters);
    if (parameter) {
      return {
        parameter
      };
    }
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return {
      literal: value
    };
  }

  return undefined;
}

export function parameterizeDiscoveredStrings<T>(value: T, parameters: ParameterizationResult): T {
  if (typeof value === "string") {
    return replaceDiscoveredStrings(value, parameters) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => parameterizeDiscoveredStrings(entry, parameters)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, parameterizeDiscoveredStrings(entry, parameters)])
    ) as T;
  }

  return value;
}

export function serializedArtifactContainsSensitiveValue(artifactYaml: string, parameters: ParameterizationResult): boolean {
  return parameters.sensitiveValues.some((value) => artifactYaml.includes(value));
}

export function stepUsesMemberParameter(step: CapabilityStep): boolean {
  return Boolean(step.value && "parameter" in step.value && step.value.parameter === "memberId");
}

function parameterForLiteral(value: string, parameters: ParameterizationResult): string | undefined {
  return Object.entries(parameters.valuesByParameter)
    .find(([, parameterValue]) => parameterValue === value)?.[0];
}

function replaceDiscoveredStrings(value: string, parameters: ParameterizationResult): string {
  return Object.entries(parameters.valuesByParameter)
    .reduce((current, [parameter, parameterValue]) => current.replaceAll(parameterValue, `{{${parameter}}}`), value);
}
