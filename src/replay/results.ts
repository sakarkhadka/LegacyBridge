import type { MoneyValue, ValueType } from "../artifact/types.js";
import type { ExecutionError } from "./errors.js";

export type OutputValue = string | number | boolean | MoneyValue;

export type TypedOutput = {
  type: ValueType;
  value: OutputValue;
};

export type SuccessResult = {
  status: "success";
  outputs: Record<string, TypedOutput>;
};

export type BusinessOutcomeResult = {
  status: "business_outcome";
  outcome: {
    code: string;
    description?: string;
  };
};

export type FailureResult = {
  status: "failure";
  error: ExecutionError;
};

export type ExecutionResult = SuccessResult | BusinessOutcomeResult | FailureResult;

