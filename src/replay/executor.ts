import type { Page } from "playwright";
import type { CapabilityArtifact, CapabilityStep, ValueSource } from "../artifact/types.js";
import type { RuntimeAuthProvider } from "../auth/types.js";
import type { EvidenceRecorder } from "../evidence/recorder.js";
import { policyConfigFromCapability } from "../policy/config.js";
import { PolicyEngine, policyRequestForUrl } from "../policy/policy-engine.js";
import { redactExecutionResult, sensitiveValuesFromInputs } from "../policy/redaction.js";
import { classifyStepRisk } from "../policy/risk-classifier.js";
import { PlaywrightSurfaceAdapter } from "../surface/playwright/playwright-adapter.js";
import { createPlaywrightSession } from "../surface/playwright/session.js";
import { conditionsPass, waitForDefinition } from "./checkpoint-engine.js";
import { parseOutput } from "./output-extractor.js";
import { failure, businessOutcome, success } from "./result-builder.js";
import {
  recoverKnownInterstitials,
  retryAttemptsFor,
  waitBeforeRetry,
  type RecoveryEvent
} from "./recovery.js";
import type { ExecutionResult, TypedOutput } from "./results.js";

export type ReplayInvocation = {
  capability: CapabilityArtifact;
  inputs: Record<string, unknown>;
  origin: string;
  scenario?: string;
  headless?: boolean;
  approvalGranted?: boolean;
  approvalHandler?: (request: ReplayApprovalRequest) => Promise<ReplayApprovalDecision>;
  authProvider?: RuntimeAuthProvider;
  evidence?: EvidenceRecorder;
};

export type ReplayApprovalDecision = boolean | {
  approved: boolean;
  completedByHuman?: boolean;
};

export type ReplayApprovalRequest = {
  capability: CapabilityArtifact;
  step: CapabilityStep;
  page: Page;
  adapter: PlaywrightSurfaceAdapter;
  reason: string;
};

export type ReplaySummary = {
  result: ExecutionResult;
  llmDecisionCalls: 0;
  recoveries: RecoveryEvent[];
};

export async function replayCapability(invocation: ReplayInvocation): Promise<ReplaySummary> {
  const sensitiveValues = sensitiveValuesFromInputs(invocation.capability, invocation.inputs);
  const inputValidationFailure = validateInputs(invocation.capability, invocation.inputs);
  if (inputValidationFailure) {
    return {
      result: redactExecutionResult(inputValidationFailure, sensitiveValues),
      llmDecisionCalls: 0,
      recoveries: []
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
    const recoveries: RecoveryEvent[] = [];
    const policyEngine = new PolicyEngine(policyConfigFromCapability(invocation.capability, invocation.origin));
    const context = {
      page: session.page,
      adapter,
      outputs
    };
    const authResult = invocation.authProvider
      ? await invocation.authProvider.authenticate({
        origin: invocation.origin,
        page: session.page,
        capability: invocation.capability,
        inputs: invocation.inputs,
        evidence: invocation.evidence
      })
      : undefined;
    const authorizationFailure = authResult && !runtimeRoleAllowsCapability(authResult.role, invocation.capability)
      ? redactExecutionResult(failure({
        class: "POLICY_VIOLATION",
        expected: "runtime user role permits capability risk",
        observed: `runtime role ${authResult.role ?? "unknown"} cannot execute ${invocation.capability.policy.risk}`
      }), sensitiveValues)
      : undefined;
    await invocation.evidence?.record("run_started", {
      payload: {
        mode: "replay",
        origin: invocation.origin,
        scenario: invocation.scenario,
        llmDecisionCalls: 0,
        auth: authResult
      }
    });
    if (authorizationFailure) {
      await invocation.evidence?.record("run_failed", {
        payload: {
          result: authorizationFailure
        }
      });
      return {
        result: authorizationFailure,
        llmDecisionCalls: 0,
        recoveries
      };
    }

    for (const step of invocation.capability.steps) {
      await invocation.evidence?.record("step_started", {
        stepId: step.id,
        payload: {
          action: step.action
        }
      });
      const policyPrecheck = await precheckStepPolicy({
        capability: invocation.capability,
        step,
        invocation,
        page: session.page,
        adapter,
        policyEngine
      });
      if (policyPrecheck?.status === "failure") {
        await invocation.evidence?.record("run_failed", {
          stepId: step.id,
          payload: {
            result: policyPrecheck
          }
        });
        return summarize(policyPrecheck, recoveries, sensitiveValues);
      }
      if (policyPrecheck?.status === "skip_step") {
        await invocation.evidence?.record("action_completed", {
          stepId: step.id,
          payload: {
            action: {
              ok: true,
              skipped: true,
              reason: "human completed approval-required action"
            }
          }
        });
        const waitedForHumanStep = await waitForDefinition(step.wait, context);
        if (!waitedForHumanStep) {
          const result = redactExecutionResult(failure({
              class: "LOAD_TIMEOUT",
              stepId: step.id,
              expected: `human-completed wait condition ${step.wait?.type ?? "unknown"} to pass`,
              observed: await observedState(session.page),
              recoverable: Boolean(step.recovery?.retries)
            }), sensitiveValues);
          await invocation.evidence?.record("run_failed", {
            stepId: step.id,
            payload: {
              result
            }
          });
          return {
            result,
            llmDecisionCalls: 0,
            recoveries
          };
        }
        const humanStepPostconditionsPass = await conditionsPass(step.postcondition, context);
        if (!humanStepPostconditionsPass) {
          const result = redactExecutionResult(failure({
              class: "POSTCONDITION_FAILED",
              stepId: step.id,
              expected: "human-completed step postconditions pass",
              observed: await observedState(session.page)
            }), sensitiveValues);
          await invocation.evidence?.record("run_failed", {
            stepId: step.id,
            payload: {
              result
            }
          });
          return {
            result,
            llmDecisionCalls: 0,
            recoveries
          };
        }
        continue;
      }

      const preconditionsPass = await conditionsPass(step.precondition, context);
      if (!preconditionsPass) {
        const result = redactExecutionResult(failure({
            class: "PRECONDITION_FAILED",
            stepId: step.id,
            expected: "step preconditions pass",
            observed: await observedState(session.page)
          }), sensitiveValues);
        await invocation.evidence?.record("run_failed", {
          stepId: step.id,
          payload: {
            result
          }
        });
        return {
          result,
          llmDecisionCalls: 0,
          recoveries
        };
      }

      const stepStartedAt = Date.now();
      const stepResult = await runStepWithRetries(step, invocation, adapter, outputs, session.page);
      const stepElapsedMs = Date.now() - stepStartedAt;
      if (stepResult.status !== "success") {
        await invocation.evidence?.record("run_failed", {
          stepId: step.id,
          payload: {
            result: stepResult
          }
        });
        return {
          result: redactExecutionResult(stepResult, sensitiveValues),
          llmDecisionCalls: 0,
          recoveries
        };
      }

      if (stepElapsedMs > 700 && step.recovery?.retries) {
        recoveries.push({
          stepId: step.id,
          condition: "TRANSIENT_LOAD",
          action: `waited ${stepElapsedMs}ms for step completion`,
          recovered: true
        });
        await invocation.evidence?.record("recovery_attempted", {
          stepId: step.id,
          payload: recoveries[recoveries.length - 1]
        });
      }

      const knownInterstitialRecoveries = await recoverKnownInterstitials(step, adapter);
      recoveries.push(...knownInterstitialRecoveries);
      for (const recovery of knownInterstitialRecoveries) {
        await invocation.evidence?.record("recovery_attempted", {
          stepId: step.id,
          payload: recovery
        });
      }

      const hardRuntimeCondition = await detectHardRuntimeCondition(session.page, step.id);
      if (hardRuntimeCondition) {
        await invocation.evidence?.record("run_failed", {
          stepId: step.id,
          payload: {
            result: hardRuntimeCondition
          }
        });
        return {
          result: redactExecutionResult(hardRuntimeCondition, sensitiveValues),
          llmDecisionCalls: 0,
          recoveries
        };
      }

      const outcome = await detectBusinessOutcome(invocation.capability, context);
      if (outcome) {
        const result = businessOutcome(outcome);
        await invocation.evidence?.record("business_outcome_detected", {
          stepId: step.id,
          payload: {
            outcome
          }
        });
        await invocation.evidence?.record("run_completed", {
          stepId: step.id,
          payload: {
            result,
            llmDecisionCalls: 0
          }
        });
        return {
          result,
          llmDecisionCalls: 0,
          recoveries
        };
      }

      const waited = await waitForDefinition(step.wait, context);
      if (!waited) {
        const outcomeAfterWait = await detectBusinessOutcome(invocation.capability, context);
        if (outcomeAfterWait) {
          const result = businessOutcome(outcomeAfterWait);
          await invocation.evidence?.record("business_outcome_detected", {
            stepId: step.id,
            payload: {
              outcome: outcomeAfterWait
            }
          });
          await invocation.evidence?.record("run_completed", {
            stepId: step.id,
            payload: {
              result,
              llmDecisionCalls: 0
            }
          });
          return {
            result,
            llmDecisionCalls: 0,
            recoveries
          };
        }

        const hardRuntimeConditionAfterWait = await detectHardRuntimeCondition(session.page, step.id);
        if (hardRuntimeConditionAfterWait) {
          await invocation.evidence?.record("run_failed", {
            stepId: step.id,
            payload: {
              result: hardRuntimeConditionAfterWait
            }
          });
          return {
            result: redactExecutionResult(hardRuntimeConditionAfterWait, sensitiveValues),
            llmDecisionCalls: 0,
            recoveries
          };
        }

        const result = redactExecutionResult(failure({
            class: "LOAD_TIMEOUT",
            stepId: step.id,
            expected: `wait condition ${step.wait?.type ?? "unknown"} to pass`,
            observed: await observedState(session.page),
            recoverable: Boolean(step.recovery?.retries)
          }), sensitiveValues);
        await invocation.evidence?.record("run_failed", {
          stepId: step.id,
          payload: {
            result
          }
        });
        return {
          result,
          llmDecisionCalls: 0,
          recoveries
        };
      }

      const postconditionsPass = await conditionsPass(step.postcondition, context);
      if (!postconditionsPass) {
        const result = redactExecutionResult(failure({
            class: "POSTCONDITION_FAILED",
            stepId: step.id,
            expected: "step postconditions pass",
            observed: await observedState(session.page)
          }), sensitiveValues);
        await invocation.evidence?.record("run_failed", {
          stepId: step.id,
          payload: {
            result
          }
        });
        return {
          result,
          llmDecisionCalls: 0,
          recoveries
        };
      }
    }

    const checkpointPasses = await conditionsPass(invocation.capability.checkpoint.conditions, context);
    if (!checkpointPasses) {
      const result = redactExecutionResult(failure({
          class: "CHECKPOINT_FAILED",
          expected: invocation.capability.checkpoint.description,
          observed: await observedState(session.page)
        }), sensitiveValues);
      await invocation.evidence?.record("run_failed", {
        payload: {
          result
        }
      });
      return {
        result,
        llmDecisionCalls: 0,
        recoveries
      };
    }

    await invocation.evidence?.record("checkpoint_passed", {
      payload: {
        checkpoint: invocation.capability.checkpoint
      }
    });
    await invocation.evidence?.record("run_completed", {
      payload: {
        result: success(outputs),
        llmDecisionCalls: 0
      }
    });
    return {
      result: success(outputs),
      llmDecisionCalls: 0,
      recoveries
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
  const resolvedTarget = step.target ? resolveTargetDescriptor(step.target, invocation) : undefined;
  const target = resolvedTarget ? await adapter.locate(resolvedTarget) : undefined;
  await invocation.evidence?.record("target_resolved", {
    stepId: step.id,
    payload: {
      target
    }
  });
  if (resolvedTarget && target?.matchCount !== 1) {
    return failure({
      class: target && target.matchCount > 1 ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
      stepId: step.id,
      expected: resolvedTarget.description ?? step.id,
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
  ).catch((error: unknown) => ({
    ok: false,
    observed: error instanceof Error ? error.message : String(error)
  }));

  if (!actionResult.ok) {
    return failure({
      class: "APPLICATION_ERROR",
      stepId: step.id,
      expected: `${step.action} action succeeds`,
      observed: actionResult.observed ?? "action failed"
    });
  }
  await invocation.evidence?.record("action_completed", {
    stepId: step.id,
    payload: {
      action: actionResult
    }
  });

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
    return value.literal
      .replaceAll("{{origin}}", invocation.origin)
      .replaceAll("{{scenarioQuery}}", invocation.scenario ? `?scenario=${encodeURIComponent(invocation.scenario)}` : "");
  }

  return value.literal;
}

function resolveTargetDescriptor<T>(target: T, invocation: ReplayInvocation): T {
  return resolveTemplateValue(target, invocation) as T;
}

function resolveTemplateValue(value: unknown, invocation: ReplayInvocation): unknown {
  if (typeof value === "string") {
    let resolved = value
      .replaceAll("{{origin}}", invocation.origin)
      .replaceAll("{{scenarioQuery}}", invocation.scenario ? `?scenario=${encodeURIComponent(invocation.scenario)}` : "");
    for (const [key, inputValue] of Object.entries(invocation.inputs)) {
      if (typeof inputValue === "string" || typeof inputValue === "number" || typeof inputValue === "boolean") {
        resolved = resolved.replaceAll(`{{${key}}}`, String(inputValue));
      }
    }
    return resolved;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry, invocation));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveTemplateValue(entry, invocation)])
    );
  }

  return value;
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

function runtimeRoleAllowsCapability(role: string | undefined, capability: CapabilityArtifact): boolean {
  if (!role) {
    return true;
  }
  if (role === "READ_WRITE") {
    return true;
  }
  if (role === "READ_ONLY") {
    return capability.policy.risk === "READ_ONLY";
  }
  return true;
}

async function precheckStepPolicy(options: {
  capability: CapabilityArtifact;
  step: CapabilityStep;
  invocation: ReplayInvocation;
  page: Page;
  adapter: PlaywrightSurfaceAdapter;
  policyEngine: PolicyEngine;
}): Promise<ExecutionResult | { status: "skip_step" } | undefined> {
  const { adapter, capability, step, invocation, page, policyEngine } = options;
  const actionRisk = classifyStepRisk(step, capability.policy.risk);
  const approvalGranted = invocation.approvalGranted ?? false;
  let url: URL;
  if (step.action === "navigate") {
    const value = step.value && "literal" in step.value && typeof step.value.literal === "string"
      ? step.value.literal
        .replaceAll("{{origin}}", invocation.origin)
        .replaceAll("{{scenarioQuery}}", invocation.scenario ? `?scenario=${encodeURIComponent(invocation.scenario)}` : "")
      : undefined;
    if (!value) {
      return undefined;
    }
    url = new URL(value);
  } else {
    url = new URL(page.url() || invocation.origin);
  }

  const decision = policyEngine.check(policyRequestForUrl({
    url,
    action: step.action,
    capabilityRisk: capability.policy.risk,
    actionRisk,
    approvalGranted
  }));
  await invocation.evidence?.record("policy_checked", {
    stepId: step.id,
    payload: {
      policy: decision,
      action: step.action,
      route: url.pathname,
      origin: url.origin,
      actionRisk
    }
  });

  if (decision.status === "allowed") {
    return undefined;
  }

  if (decision.status === "requires_human_approval" && invocation.approvalHandler) {
    await invocation.evidence?.record("intervention_created", {
      stepId: step.id,
      payload: {
        reason: "RISK_APPROVAL_REQUIRED",
        actionRisk,
        route: url.pathname
      }
    });
    const approvalDecision = await invocation.approvalHandler({
      capability,
      step,
      page,
      adapter,
      reason: decision.reason
    });
    const approved = typeof approvalDecision === "boolean" ? approvalDecision : approvalDecision.approved;
    const completedByHuman = typeof approvalDecision === "boolean" ? false : approvalDecision.completedByHuman === true;
    await invocation.evidence?.record("human_action", {
      stepId: step.id,
      payload: {
        action: approved ? (completedByHuman ? "completed_by_human" : "approved") : "not_approved"
      }
    });
    if (approved) {
      if (completedByHuman) {
        return {
          status: "skip_step"
        };
      }
      return undefined;
    }
  }

  return failure({
    class: "POLICY_VIOLATION",
    stepId: step.id,
    expected: decision.status === "requires_human_approval" ? "human approval for irreversible action" : "policy check passes",
    observed: decision.reason
  });
}

async function detectBusinessOutcome(capability: CapabilityArtifact, context: Parameters<typeof conditionsPass>[1]) {
  for (const outcome of capability.outcomes) {
    if (await conditionsPass(outcome.when, context)) {
      return outcome;
    }
  }
  return undefined;
}

async function detectHardRuntimeCondition(page: Page, stepId: string): Promise<ExecutionResult | undefined> {
  const state = await observedState(page);
  const title = await page.title().catch(() => "");
  const text = await pageText(page);

  if (title === "Session Expired" || text.includes("Your host session has expired")) {
    return failure({
      class: "SESSION_EXPIRED",
      stepId,
      expected: "active host session",
      observed: state
    });
  }

  if (title.includes("Permission Denied") || text.includes("Operator role may not view member")) {
    return failure({
      class: "PERMISSION_DENIED",
      stepId,
      expected: "operator may view member record",
      observed: state
    });
  }

  if (title === "Application Error" || text.includes("Simulated host exception")) {
    return failure({
      class: "APPLICATION_ERROR",
      stepId,
      expected: "host application screen without server error",
      observed: state
    });
  }

  return undefined;
}

async function pageText(page: Page): Promise<string> {
  const chunks: string[] = [];
  for (const frame of page.frames()) {
    chunks.push(await frame.locator("body").innerText().catch(() => ""));
  }
  return chunks.join("\n");
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

function summarize(result: ExecutionResult, recoveries: RecoveryEvent[], sensitiveValues: string[]): ReplaySummary {
  return {
    result: redactExecutionResult(result, sensitiveValues),
    llmDecisionCalls: 0,
    recoveries
  };
}
