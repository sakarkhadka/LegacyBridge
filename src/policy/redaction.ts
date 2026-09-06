import type { CapabilityArtifact } from "../artifact/types.js";
import type { ExecutionResult } from "../replay/results.js";

const redactionToken = "[REDACTED]";

export function sensitiveValuesFromInputs(capability: CapabilityArtifact, inputs: Record<string, unknown>): string[] {
  return Object.entries(capability.inputs)
    .filter(([, definition]) => definition.sensitive)
    .map(([name]) => inputs[name])
    .filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value))
    .map(String)
    .filter((value) => value.length > 0);
}

export function redactText(text: string, sensitiveValues: string[]): string {
  const explicitRedactions = sensitiveValues.reduce((redacted, value) => redacted.replaceAll(value, redactionToken), text);
  return explicitRedactions.replace(/\b[A-Z]-\d{6}\b/g, redactionToken);
}

export function redactStructuredValue<T>(value: T, sensitiveValues: string[]): T {
  if (typeof value === "string") {
    return redactText(value, sensitiveValues) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredValue(item, sensitiveValues)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactStructuredValue(entry, sensitiveValues)])
    ) as T;
  }

  return value;
}

export function redactExecutionResult(result: ExecutionResult, sensitiveValues: string[]): ExecutionResult {
  return redactStructuredValue(result, sensitiveValues);
}

export function redactLogEvent<T extends Record<string, unknown>>(event: T, sensitiveValues: string[]): T {
  return redactStructuredValue(event, sensitiveValues);
}
