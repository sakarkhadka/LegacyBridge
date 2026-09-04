import type { BusinessOutcomeDefinition } from "../artifact/types.js";
import type { FailureClass } from "./errors.js";
import type { BusinessOutcomeResult, FailureResult, SuccessResult, TypedOutput } from "./results.js";

export function success(outputs: Record<string, TypedOutput>): SuccessResult {
  return {
    status: "success",
    outputs
  };
}

export function businessOutcome(outcome: BusinessOutcomeDefinition): BusinessOutcomeResult {
  return {
    status: "business_outcome",
    outcome: {
      code: outcome.code,
      description: outcome.description
    }
  };
}

export function failure(options: {
  class: FailureClass;
  stepId?: string;
  expected: string;
  observed: string;
  recoverable?: boolean;
}): FailureResult {
  return {
    status: "failure",
    error: {
      class: options.class,
      stepId: options.stepId,
      expected: options.expected,
      observed: options.observed,
      recoverable: options.recoverable ?? false
    }
  };
}

