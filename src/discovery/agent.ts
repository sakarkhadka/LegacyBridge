import type { CapabilityArtifact, StepAction, TargetDescriptor } from "../artifact/types.js";
import type { EvidenceRecorder } from "../evidence/recorder.js";
import { policyConfigFromCapability } from "../policy/config.js";
import { PolicyEngine, policyRequestForUrl } from "../policy/policy-engine.js";
import { classifyStepRisk } from "../policy/risk-classifier.js";
import type { SurfaceAction, SurfaceAdapter } from "../surface/types.js";
import type { AgentDecision } from "./decision-schema.js";
import type { DiscoveryModel } from "./model.js";
import { buildDiscoveryContext } from "./prompt.js";
import type { DiscoveryRunResult, DiscoveryTraceEvent } from "./run-state.js";

export type DiscoveryAgentOptions = {
  goal: string;
  entrypoint: string;
  surface: SurfaceAdapter;
  model: DiscoveryModel;
  policyCapability: CapabilityArtifact;
  maxSteps?: number;
  timeoutMs?: number;
  evidence?: EvidenceRecorder;
};

export async function runDiscovery(options: DiscoveryAgentOptions): Promise<DiscoveryRunResult> {
  const maxSteps = options.maxSteps ?? 8;
  const startedAt = Date.now();
  const trace: DiscoveryTraceEvent[] = [];
  const policyEngine = new PolicyEngine(policyConfigFromCapability(options.policyCapability, new URL(options.entrypoint).origin));
  let previousActionResult: unknown;
  let modelDecisionCalls = 0;

  await options.evidence?.record("run_started", {
    payload: {
      mode: "discovery",
      entrypoint: options.entrypoint,
      maxSteps
    }
  });
  await options.surface.act({
    type: "navigate",
    value: options.entrypoint
  });

  for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber += 1) {
    if (Date.now() - startedAt > (options.timeoutMs ?? 30_000)) {
      return stopped("timeout", trace, modelDecisionCalls, stepNumber - 1);
    }

    const observation = await options.surface.observe();
    trace.push({
      type: "observation",
      stepNumber,
      observation
    });
    await options.evidence?.record("observation_captured", {
      payload: {
        stepNumber,
        observation
      }
    });

    const context = buildDiscoveryContext({
      goal: options.goal,
      stepNumber,
      maxSteps,
      observation,
      previousActionResult,
      allowedActionTypes: options.policyCapability.policy.allowedActions
    });

    const decision = await options.model.decide(context).catch((error: unknown) => {
      previousActionResult = error instanceof Error ? error.message : String(error);
      trace.push({
        type: "action_result",
        stepNumber,
        result: previousActionResult
      });
      return undefined;
    });
    if (!decision) {
      return stopped("execution_failed", trace, modelDecisionCalls, stepNumber - 1);
    }
    modelDecisionCalls += 1;
    trace.push({
      type: "model_decision",
      stepNumber,
      decision
    });
    await options.evidence?.record("model_decision", {
      payload: {
        stepNumber,
        decision
      }
    });

    if (decision.type === "goal_complete") {
      if (!goalCompletionIsVerified(decision, observation, previousActionResult)) {
        previousActionResult = "goal_complete was not verified against current observation";
        trace.push({
          type: "action_result",
          stepNumber,
          result: previousActionResult
        });
        await options.evidence?.record("run_failed", {
          payload: {
            stopReason: "execution_failed",
            observed: previousActionResult
          }
        });
        return stopped("execution_failed", trace, modelDecisionCalls, stepNumber - 1);
      }

      await options.evidence?.record("run_completed", {
        payload: {
          stopReason: "goal_completed",
          outputs: decision.outputs,
          modelDecisionCalls
        }
      });
      return {
        status: "success",
        stopReason: "goal_completed",
        outputs: decision.outputs,
        stepsExecuted: stepNumber - 1,
        trace,
        modelDecisionCalls
      };
    }

    if (decision.type === "dead_end") {
      await options.evidence?.record("run_failed", {
        payload: {
          stopReason: "dead_end",
          reason: decision.reason
        }
      });
      return stopped("dead_end", trace, modelDecisionCalls, stepNumber - 1);
    }

    if (decision.type === "intervention_required") {
      await options.evidence?.record("run_failed", {
        payload: {
          stopReason: "intervention_required",
          reason: decision.reason
        }
      });
      return stopped("intervention_required", trace, modelDecisionCalls, stepNumber - 1);
    }

    const policyFailure = policyFailureForDecision(decision, observation.url, options.policyCapability, policyEngine);
    await options.evidence?.record("policy_checked", {
      payload: {
        stepNumber,
        action: decision.action.type,
        allowed: !policyFailure,
        reason: policyFailure
      }
    });
    if (policyFailure) {
      previousActionResult = policyFailure;
      trace.push({
        type: "action_result",
        stepNumber,
        result: policyFailure
      });
      await options.evidence?.record("run_failed", {
        payload: {
          stopReason: "policy_blocked",
          observed: policyFailure
        }
      });
      return stopped("policy_blocked", trace, modelDecisionCalls, stepNumber - 1);
    }

    const actionResult = await executeDecision(options.surface, decision);
    previousActionResult = actionResult;
    trace.push({
      type: "action_result",
      stepNumber,
      result: actionResult
    });
    await options.evidence?.record("action_completed", {
      payload: {
        stepNumber,
        action: actionResult
      }
    });

    if (!actionResult.ok) {
      await options.evidence?.record("run_failed", {
        payload: {
          stopReason: "execution_failed",
          observed: actionResult
        }
      });
      return stopped("execution_failed", trace, modelDecisionCalls, stepNumber);
    }
  }

  await options.evidence?.record("run_failed", {
    payload: {
      stopReason: "max_steps"
    }
  });
  return stopped("max_steps", trace, modelDecisionCalls, maxSteps);
}

function goalCompletionIsVerified(
  decision: Extract<AgentDecision, { type: "goal_complete" }>,
  observation: { visibleText: string[] },
  previousActionResult: unknown
): boolean {
  const claimedOutputs = Object.values(decision.outputs).filter(Boolean);
  if (claimedOutputs.length === 0) {
    return false;
  }

  const visibleText = observation.visibleText.join("\n");
  const previousResult = JSON.stringify(previousActionResult ?? {});
  return claimedOutputs.every((output) => visibleText.includes(output) || previousResult.includes(output));
}

async function executeDecision(surface: SurfaceAdapter, decision: Extract<AgentDecision, { type: "act" }>) {
  const action: SurfaceAction = {
    type: decision.action.type,
    value: decision.action.value
  };
  const target = decision.action.target ? await surface.locate(decision.action.target as TargetDescriptor) : undefined;

  if (decision.action.target && target?.matchCount !== 1) {
    return {
      ok: false,
      observed: `target matchCount=${target?.matchCount ?? 0}`
    };
  }

  return surface.act(action, target);
}

function policyFailureForDecision(
  decision: Extract<AgentDecision, { type: "act" }>,
  currentUrl: string,
  capability: CapabilityArtifact,
  policyEngine: PolicyEngine
): string | undefined {
  const url = decision.action.type === "navigate" && typeof decision.action.value === "string"
    ? new URL(decision.action.value)
    : new URL(currentUrl);
  const syntheticStep = {
    id: "discovery-step",
    action: decision.action.type as StepAction
  };
  const policyDecision = policyEngine.check(policyRequestForUrl({
    url,
    action: decision.action.type as StepAction,
    capabilityRisk: capability.policy.risk,
    actionRisk: classifyStepRisk(syntheticStep, capability.policy.risk)
  }));

  if (policyDecision.status === "allowed") {
    return undefined;
  }

  return policyDecision.reason;
}

function stopped(
  stopReason: DiscoveryRunResult["stopReason"],
  trace: DiscoveryTraceEvent[],
  modelDecisionCalls: number,
  stepsExecuted: number
): DiscoveryRunResult {
  return {
    status: "stopped",
    stopReason,
    outputs: {},
    stepsExecuted,
    trace,
    modelDecisionCalls
  };
}
