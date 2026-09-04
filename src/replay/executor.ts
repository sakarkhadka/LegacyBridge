import type { Page } from "playwright";
import type { CapabilityArtifact, CapabilityStep, ValueSource } from "../artifact/types.js";
import { PlaywrightSurfaceAdapter } from "../surface/playwright/playwright-adapter.js";
import { createPlaywrightSession } from "../surface/playwright/session.js";
import { conditionsPass, waitForDefinition } from "./checkpoint-engine.js";
import { parseOutput } from "./output-extractor.js";
import { failure, businessOutcome, success } from "./result-builder.js";
import { retryAttemptsFor, waitBeforeRetry } from "./recovery.js";
import type { ExecutionResult, TypedOutput } from "./results.js";

export type ReplayInvocation = {
  capability: CapabilityArtifact;
  inputs: Record<string, unknown>;
  origin: string;
  headless?: boolean;
};

export type ReplaySummary = {
  result: ExecutionResult;
  llmDecisionCalls: 0;
};

export async function replayCapability(invocation: ReplayInvocation): Promise<ReplaySummary> {
  const inputValidationFailure = validateInputs(invocation.capability, invocation.inputs);
  if (inputValidationFailure) {
    return {
      result: inputValidationFailure,
      llmDecisionCalls: 0
    };
  }

  const session = await createPlaywrightSession({
    headless: invocation.headless ?? true
  });

  try {
    const adapter = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const outputs: Record<string, TypedOutput> = {};
    const context = {
      page: session.page,
      adapter,
      outputs
    };

    for (const step of invocation.capability.steps) {
      const policyFailure = precheckStepPolicy(invocation.capability, step, invocation.origin);
      if (policyFailure) {
        return { result: policyFailure, llmDecisionCalls: 0 };
      }

      const preconditionsPass = await conditionsPass(step.precondition, context);
      if (!preconditionsPass) {
        return {
          result: failure({
            class: "PRECONDITION_FAILED",
            stepId: step.id,
            expected: "step preconditions pass",
            observed: await observedState(session.page)
          }),
          llmDecisionCalls: 0
        };
      }

      const stepResult = await runStepWithRetries(step, invocation, adapter, outputs, session.page);
      if (stepResult.status !== "success") {
        return {
          result: stepResult,
          llmDecisionCalls: 0
        };
      }

      const outcome = await detectBusinessOutcome(invocation.capability, context);
      if (outcome) {
        return {
          result: businessOutcome(outcome),
          llmDecisionCalls: 0
        };
      }

      const waited = await waitForDefinition(step.wait, context);
      if (!waited) {
        const outcomeAfterWait = await detectBusinessOutcome(invocation.capability, context);
        if (outcomeAfterWait) {
          return {
            result: businessOutcome(outcomeAfterWait),
            llmDecisionCalls: 0
          };
        }

        return {
          result: failure({
            class: "LOAD_TIMEOUT",
            stepId: step.id,
            expected: `wait condition ${step.wait?.type ?? "unknown"} to pass`,
            observed: await observedState(session.page),
            recoverable: Boolean(step.recovery?.retries)
          }),
          llmDecisionCalls: 0
        };
      }

      const postconditionsPass = await conditionsPass(step.postcondition, context);
      if (!postconditionsPass) {
        return {
          result: failure({
            class: "POSTCONDITION_FAILED",
            stepId: step.id,
            expected: "step postconditions pass",
            observed: await observedState(session.page)
          }),
          llmDecisionCalls: 0
        };
      }
    }

    const checkpointPasses = await conditionsPass(invocation.capability.checkpoint.conditions, context);
    if (!checkpointPasses) {
      return {
        result: failure({
          class: "CHECKPOINT_FAILED",
          expected: invocation.capability.checkpoint.description,
          observed: await observedState(session.page)
        }),
        llmDecisionCalls: 0
      };
    }

    return {
      result: success(outputs),
      llmDecisionCalls: 0
    };
  } finally {
    await session.close();
  }
}

async function runStepWithRetries(
  step: CapabilityStep,
  invocation: ReplayInvocation,
  adapter: PlaywrightSurfaceAdapter,
  outputs: Record<string, TypedOutput>,
  page: Page
): Promise<ExecutionResult> {
  const attempts = retryAttemptsFor(step) + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runStep(step, invocation, adapter, outputs);
    if (result.status === "success") {
      return result;
    }

    if (attempt < attempts) {
      await waitBeforeRetry(step);
      continue;
    }

    if (result.status === "failure" && result.error.class === "TARGET_NOT_FOUND") {
      return {
        status: "failure",
        error: {
          ...result.error,
          observed: `${result.error.observed}; page=${await observedState(page)}`
        }
      };
    }

    return result;
  }

  return failure({
    class: "APPLICATION_ERROR",
    stepId: step.id,
    expected: "step execution",
    observed: "retry loop exhausted unexpectedly"
  });
}

async function runStep(
  step: CapabilityStep,
  invocation: ReplayInvocation,
  adapter: PlaywrightSurfaceAdapter,
  outputs: Record<string, TypedOutput>
): Promise<ExecutionResult> {
  const target = step.target ? await adapter.locate(step.target) : undefined;
  if (step.target && target?.matchCount !== 1) {
    return failure({
      class: target && target.matchCount > 1 ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
      stepId: step.id,
      expected: step.target.description ?? step.id,
      observed: `matchCount=${target?.matchCount ?? 0}`,
      recoverable: Boolean(step.recovery?.retries)
    });
  }

  const actionResult = await adapter.act(
    {
      type: step.action,
      value: resolveValue(step.value, invocation)
    },
    target
  );

  if (!actionResult.ok) {
    return failure({
      class: "APPLICATION_ERROR",
      stepId: step.id,
      expected: `${step.action} action succeeds`,
      observed: actionResult.observed ?? "action failed"
    });
  }

  if (step.output) {
    if (!actionResult.observed) {
      return failure({
        class: "APPLICATION_ERROR",
        stepId: step.id,
        expected: `extract output ${step.output.name}`,
        observed: "no output text observed"
      });
    }

    outputs[step.output.name] = parseOutput(actionResult.observed, step.output.parseAs);
  }

  return success({});
}

function resolveValue(value: ValueSource | undefined, invocation: ReplayInvocation): unknown {
  if (!value) {
    return undefined;
  }

  if ("parameter" in value) {
    return invocation.inputs[value.parameter];
  }

  if (typeof value.literal === "string") {
    return value.literal.replaceAll("{{origin}}", invocation.origin);
  }

  return value.literal;
}

function validateInputs(capability: CapabilityArtifact, inputs: Record<string, unknown>): ExecutionResult | undefined {
  for (const [name, definition] of Object.entries(capability.inputs)) {
    const value = inputs[name];

    if (definition.required && (value === undefined || value === null || value === "")) {
      return failure({
        class: "PRECONDITION_FAILED",
        expected: `required input ${name}`,
        observed: "missing invocation input"
      });
    }

    if (typeof value === "string" && definition.pattern && !new RegExp(definition.pattern).test(value)) {
      return failure({
        class: "PRECONDITION_FAILED",
        expected: `input ${name} matches ${definition.pattern}`,
        observed: "input did not match pattern"
      });
    }
  }

  return undefined;
}

function precheckStepPolicy(capability: CapabilityArtifact, step: CapabilityStep, origin: string): ExecutionResult | undefined {
  if (!capability.policy.allowedActions.includes(step.action)) {
    return failure({
      class: "POLICY_VIOLATION",
      stepId: step.id,
      expected: `action ${step.action} allowed by policy`,
      observed: "action is not in allowedActions"
    });
  }

  if (step.action === "navigate") {
    const value = step.value && "literal" in step.value && typeof step.value.literal === "string"
      ? step.value.literal.replaceAll("{{origin}}", origin)
      : undefined;
    if (!value) {
      return undefined;
    }
    const url = new URL(value);
    const allowedOrigins = capability.policy.allowedOrigins.map((allowedOrigin) => allowedOrigin.replaceAll("{{origin}}", origin));
    if (!allowedOrigins.includes(url.origin)) {
      return failure({
        class: "POLICY_VIOLATION",
        stepId: step.id,
        expected: `origin in ${allowedOrigins.join(", ")}`,
        observed: url.origin
      });
    }

    if (!capability.policy.allowedRoutes.some((routePattern) => routeMatches(routePattern, url.pathname))) {
      return failure({
        class: "POLICY_VIOLATION",
        stepId: step.id,
        expected: `route in ${capability.policy.allowedRoutes.join(", ")}`,
        observed: url.pathname
      });
    }
  }

  return undefined;
}

function routeMatches(pattern: string, pathname: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(pathname);
}

async function detectBusinessOutcome(capability: CapabilityArtifact, context: Parameters<typeof conditionsPass>[1]) {
  for (const outcome of capability.outcomes) {
    if (await conditionsPass(outcome.when, context)) {
      return outcome;
    }
  }
  return undefined;
}

async function observedState(page: Page): Promise<string> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  const text = await page.locator("body").innerText().catch(() => "");
  return JSON.stringify({
    url,
    title,
    text: text.slice(0, 300)
  });
}
