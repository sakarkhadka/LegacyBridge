import { stringify } from "yaml";
import { parseCapabilityArtifact } from "../artifact/schema.js";
import type { CapabilityArtifact, CapabilityStep, StepRecovery, TargetDescriptor } from "../artifact/types.js";
import type { AgentDecision } from "./decision-schema.js";
import { buildDiscoveryCheckpoint } from "./checkpoint-builder.js";
import { parameterizationFromDiscovery, parameterizeStepValue, serializedArtifactContainsSensitiveValue } from "./parameterizer.js";
import type { DiscoveryRunResult } from "./run-state.js";
import { normalizeTarget } from "./target-normalizer.js";

export type CompileDiscoveryOptions = {
  goal: string;
  run: DiscoveryRunResult;
};

type ActionDecision = Extract<AgentDecision, { type: "act" }>;

export function compileDiscoveryToArtifact(options: CompileDiscoveryOptions): CapabilityArtifact {
  if (options.run.status !== "success") {
    throw new Error(`Cannot compile unsuccessful discovery run: ${options.run.stopReason}`);
  }

  const decisions = options.run.trace
    .filter((event) => event.type === "model_decision")
    .map((event) => event.decision);
  const parameterization = parameterizationFromDiscovery(options.goal, decisions);
  const actionDecisions = decisions.filter((decision): decision is ActionDecision => decision.type === "act");
  const steps = [
    navigationStep(),
    ...actionDecisions.map((decision, index) => compileDecisionStep(decision, index + 1, parameterization))
  ];

  const artifact = parseCapabilityArtifact({
    schemaVersion: "1.0",
    capability: {
      id: "member.get-savings-balance.generated",
      version: "0.1.0",
      name: "Get savings balance",
      description: "Draft generated from discovery for deterministic replay of a synthetic member savings lookup.",
      status: "draft"
    },
    targetApplication: {
      vendor: "heritage-core",
      application: "Heritage Core Servicing",
      supportedVersions: ["demo"],
      fingerprint: {
        titlePatterns: ["Heritage Core Servicing"],
        routePatterns: ["/servicing/*"],
        landmarks: ["Member Search", "Accounts"]
      }
    },
    inputs: parameterization.inputs,
    outputs: {
      balance: {
        type: "money",
        required: true,
        description: "Current savings balance."
      }
    },
    outcomes: [
      {
        code: "MEMBER_NOT_FOUND",
        description: "No member exists for the supplied member number.",
        when: [
          {
            type: "text_present",
            value: "Member not found"
          }
        ]
      }
    ],
    steps,
    checkpoint: buildDiscoveryCheckpoint("balance"),
    policy: {
      allowedOrigins: ["{{origin}}", "http://localhost:3000"],
      allowedRoutes: ["/servicing/*"],
      allowedActions: ["navigate", "click", "fill", "select", "extract", "wait"],
      risk: "READ_ONLY"
    }
  });

  const yaml = stringify(artifact, { lineWidth: 0 });
  if (serializedArtifactContainsSensitiveValue(yaml, parameterization)) {
    throw new Error("Generated artifact still contains a discovered sensitive value");
  }

  return artifact;
}

function navigationStep(): CapabilityStep {
  return {
    id: "navigate-to-search",
    action: "navigate",
    value: {
      literal: "{{origin}}/servicing/search{{scenarioQuery}}"
    },
    wait: {
      type: "navigation",
      timeoutMs: 5000
    },
    recovery: sharedNavigationRecovery(),
    postcondition: [
      {
        type: "text_present",
        value: "Member Search"
      }
    ]
  };
}

function compileDecisionStep(
  decision: ActionDecision,
  index: number,
  parameterization: ReturnType<typeof parameterizationFromDiscovery>
): CapabilityStep {
  const target = normalizeTarget(decision.action.target as TargetDescriptor | undefined);
  const base: CapabilityStep = {
    id: stepIdForDecision(decision, index),
    action: decision.action.type,
    target,
    value: parameterizeStepValue(decision.action.value, parameterization)
  };

  if (decision.action.type === "click") {
    return {
      ...base,
      wait: {
        type: "text",
        text: "Accounts",
        timeoutMs: 5000
      },
      recovery: retryRecovery()
    };
  }

  if (decision.action.type === "extract") {
    return {
      ...base,
      output: {
        name: "balance",
        parseAs: "money",
        source: target
      }
    };
  }

  return pruneUndefined(base);
}

function stepIdForDecision(decision: ActionDecision, index: number): string {
  if (decision.action.type === "fill") {
    return "enter-member-id";
  }
  if (decision.action.type === "click") {
    return "search-member";
  }
  if (decision.action.type === "extract") {
    return "extract-savings-balance";
  }
  return `${decision.action.type}-${index}`;
}

function sharedNavigationRecovery(): StepRecovery {
  return {
    ...retryRecovery(),
    knownDialogs: [
      {
        title: "System Notice",
        response: "dismiss"
      }
    ]
  };
}

function retryRecovery(): StepRecovery {
  return {
    retries: {
      maxAttempts: 1,
      backoffMs: 250
    }
  };
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
