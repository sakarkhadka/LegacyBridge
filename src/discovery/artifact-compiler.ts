import { stringify } from "yaml";
import { parseCapabilityArtifact } from "../artifact/schema.js";
import type {
  CapabilityArtifact,
  CapabilityStep,
  ConditionDefinition,
  OutputDefinition,
  StepRecovery,
  TargetDescriptor,
  WaitDefinition
} from "../artifact/types.js";
import type { RiskClassification } from "../policy/types.js";
import type { AgentDecision } from "./decision-schema.js";
import { buildDiscoveryCheckpoint } from "./checkpoint-builder.js";
import {
  parameterizationFromDiscovery,
  parameterizeDiscoveredStrings,
  parameterizeStepValue,
  serializedArtifactContainsSensitiveValue
} from "./parameterizer.js";
import type { DiscoveryRunResult } from "./run-state.js";
import { normalizeTarget } from "./target-normalizer.js";

export type CompileDiscoveryOptions = {
  goal: string;
  run: DiscoveryRunResult;
  capabilityId?: CompilableCapabilityId;
};

type ActionDecision = Extract<AgentDecision, { type: "act" }>;
export type CompilableCapabilityId =
  | "member.get-account-balances"
  | "member.deposit-to-account"
  | "member.withdraw-from-account"
  | "member.get-transaction-history";

type StepOverride = {
  id: string;
  wait?: WaitDefinition;
  risk?: RiskClassification;
  output?: {
    name: string;
    parseAs: NonNullable<CapabilityStep["output"]>["parseAs"];
  };
  recovery?: StepRecovery;
};

type CompilerProfile = {
  generatedId: string;
  name: string;
  description: string;
  outputs: Record<string, OutputDefinition>;
  checkpointOutput: string;
  checkpointDescription: string;
  outcomes: Array<{
    code: string;
    description: string;
    when: ConditionDefinition[];
  }>;
  risk: RiskClassification;
  approvalRequired?: boolean;
  actionOverrides: StepOverride[];
};

export function compileDiscoveryToArtifact(options: CompileDiscoveryOptions): CapabilityArtifact {
  if (options.run.status !== "success") {
    throw new Error(`Cannot compile unsuccessful discovery run: ${options.run.stopReason}`);
  }

  const profile = compilerProfileFor(options.capabilityId ?? "member.get-account-balances");
  const decisions = options.run.trace
    .filter((event) => event.type === "model_decision")
    .map((event) => event.decision);
  const parameterization = parameterizationFromDiscovery(options.goal, decisions);
  const actionDecisions = decisions.filter((decision): decision is ActionDecision => decision.type === "act");
  const steps = [
    navigationStep(),
    ...actionDecisions.map((decision, index) => compileDecisionStep(decision, index + 1, parameterization, profile))
  ];

  const artifact = parseCapabilityArtifact({
    schemaVersion: "1.0",
    capability: {
      id: profile.generatedId,
      version: "0.1.0",
      name: profile.name,
      description: profile.description,
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
    outputs: profile.outputs,
    outcomes: profile.outcomes,
    steps,
    checkpoint: buildDiscoveryCheckpoint(profile.checkpointOutput, profile.checkpointDescription),
    policy: {
      allowedOrigins: ["{{origin}}", "http://localhost:3000"],
      allowedRoutes: ["/servicing/*"],
      allowedActions: ["navigate", "click", "fill", "select", "extract", "wait"],
      risk: profile.risk,
      approvalRequired: profile.approvalRequired
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
  parameterization: ReturnType<typeof parameterizationFromDiscovery>,
  profile: CompilerProfile
): CapabilityStep {
  const override = profile.actionOverrides[index - 1];
  const target = parameterizeDiscoveredStrings(
    normalizeTarget(decision.action.target as TargetDescriptor | undefined),
    parameterization
  );
  const base: CapabilityStep = {
    id: override?.id ?? stepIdForDecision(decision, index),
    action: decision.action.type,
    target,
    value: parameterizeStepValue(decision.action.value, parameterization),
    risk: override?.risk
  };

  return pruneUndefined({
    ...base,
    wait: override?.wait,
    recovery: override?.recovery ?? (decision.action.type === "click" ? retryRecovery() : undefined),
    output: override?.output && target
      ? {
        ...override.output,
        source: target
      }
      : undefined
  });
}

function stepIdForDecision(decision: ActionDecision, index: number): string {
  if (decision.action.type === "fill") {
    return "enter-member-id";
  }
  if (decision.action.type === "click") {
    return "search-member";
  }
  if (decision.action.type === "extract") {
    return "extract-account-balances";
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

function compilerProfileFor(capabilityId: CompilableCapabilityId): CompilerProfile {
  if (capabilityId === "member.deposit-to-account") {
    return {
      generatedId: "member.deposit-to-account.generated",
      name: "Deposit to account",
      description: "Draft generated from discovery for deterministic replay of an approval-gated account deposit.",
      outputs: {
        newBalance: {
          type: "money",
          required: true,
          description: "Account balance after the deposit is confirmed."
        }
      },
      checkpointOutput: "newBalance",
      checkpointDescription: "Deposit completed and the resulting account balance was extracted.",
      outcomes: commonWriteOutcomes(),
      risk: "REVERSIBLE_WRITE",
      approvalRequired: true,
      actionOverrides: [
        { id: "enter-member-id" },
        { id: "search-member", wait: textWait("Accounts"), recovery: retryRecovery() },
        { id: "open-deposit-screen", wait: textWait("Deposit Funds"), recovery: retryRecovery() },
        { id: "enter-deposit-amount" },
        { id: "review-deposit", wait: textWait("Deposit Review"), recovery: retryRecovery() },
        { id: "confirm-deposit", wait: textWait("Deposit Confirmation"), risk: "IRREVERSIBLE_WRITE", recovery: retryRecovery() },
        { id: "extract-new-balance", output: { name: "newBalance", parseAs: "money" } }
      ]
    };
  }

  if (capabilityId === "member.withdraw-from-account") {
    return {
      generatedId: "member.withdraw-from-account.generated",
      name: "Withdraw from account",
      description: "Draft generated from discovery for deterministic replay of an approval-gated account withdrawal.",
      outputs: {
        newBalance: {
          type: "money",
          required: true,
          description: "Account balance after the withdrawal is confirmed."
        }
      },
      checkpointOutput: "newBalance",
      checkpointDescription: "Withdrawal completed and the resulting account balance was extracted.",
      outcomes: [
        ...commonWriteOutcomes(),
        {
          code: "INSUFFICIENT_FUNDS",
          description: "The requested withdrawal exceeds the account balance.",
          when: [{ type: "text_present", value: "Insufficient funds" }]
        }
      ],
      risk: "REVERSIBLE_WRITE",
      approvalRequired: true,
      actionOverrides: [
        { id: "enter-member-id" },
        { id: "search-member", wait: textWait("Accounts"), recovery: retryRecovery() },
        { id: "open-withdraw-screen", wait: textWait("Withdraw Funds"), recovery: retryRecovery() },
        { id: "enter-withdrawal-amount" },
        { id: "review-withdrawal", wait: textWait("Withdrawal Review"), recovery: retryRecovery() },
        { id: "confirm-withdrawal", wait: textWait("Withdrawal Confirmation"), risk: "IRREVERSIBLE_WRITE", recovery: retryRecovery() },
        { id: "extract-new-balance", output: { name: "newBalance", parseAs: "money" } }
      ]
    };
  }

  if (capabilityId === "member.get-transaction-history") {
    return {
      generatedId: "member.get-transaction-history.generated",
      name: "Get transaction history",
      description: "Draft generated from discovery for deterministic replay of account transaction history lookup.",
      outputs: {
        transactions: {
          type: "transactionHistory",
          required: true,
          description: "Up to ten most recent transactions for the requested account."
        }
      },
      checkpointOutput: "transactions",
      checkpointDescription: "Transaction history was extracted from the account transaction table.",
      outcomes: commonReadOutcomes(),
      risk: "READ_ONLY",
      actionOverrides: [
        { id: "enter-member-id" },
        { id: "search-member", wait: textWait("Accounts"), recovery: retryRecovery() },
        { id: "open-transaction-history", wait: textWait("Most Recent 10 Transactions"), recovery: retryRecovery() },
        { id: "extract-transactions", output: { name: "transactions", parseAs: "transactionHistory" } }
      ]
    };
  }

  return {
    generatedId: "member.get-account-balances.generated",
    name: "Get account balances",
    description: "Draft generated from discovery for deterministic replay of a synthetic member account balance lookup.",
    outputs: {
      accountBalances: {
        type: "accountBalances",
        required: true,
        description: "Available account balances for the member."
      }
    },
    checkpointOutput: "accountBalances",
    checkpointDescription: "Account balances were extracted from the member account table.",
    outcomes: commonReadOutcomes(),
    risk: "READ_ONLY",
    actionOverrides: [
      { id: "enter-member-id" },
      { id: "search-member", wait: textWait("Accounts"), recovery: retryRecovery() },
      { id: "extract-account-balances", output: { name: "accountBalances", parseAs: "accountBalances" } }
    ]
  };
}

function commonReadOutcomes(): CompilerProfile["outcomes"] {
  return [
    {
      code: "MEMBER_NOT_FOUND",
      description: "No member exists for the supplied member number.",
      when: [{ type: "text_present", value: "Member not found" }]
    },
    {
      code: "ACCOUNT_NOT_FOUND",
      description: "The requested account number does not exist for the member.",
      when: [{ type: "text_present", value: "Account not found" }]
    }
  ];
}

function commonWriteOutcomes(): CompilerProfile["outcomes"] {
  return [
    ...commonReadOutcomes(),
    {
      code: "INVALID_AMOUNT",
      description: "The supplied amount is not a valid positive dollar amount.",
      when: [{ type: "text_present", value: "Invalid amount" }]
    }
  ];
}

function textWait(text: string): WaitDefinition {
  return {
    type: "text",
    text,
    timeoutMs: 5000
  };
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
