import type { FailureClass } from "../replay/errors.js";

export const capabilityStatuses = [
  "draft",
  "validated",
  "approved",
  "active",
  "deprecated"
] as const;

export type CapabilityStatus = (typeof capabilityStatuses)[number];

export const valueTypes = ["string", "number", "boolean", "money", "enum", "accountBalances", "transactionHistory"] as const;

export type ValueType = (typeof valueTypes)[number];

export type MoneyValue = {
  amount: number;
  currency: string;
};

export type AccountBalanceValue = {
  accountType: string;
  balance: MoneyValue;
};

export type TransactionHistoryValue = {
  datetime: string;
  accountNumber: string;
  accountType: string;
  type: "Deposit" | "Withdraw";
  amount: MoneyValue;
  balance: MoneyValue;
};

export type InputDefinition = {
  type: ValueType;
  required: boolean;
  sensitive?: boolean;
  description: string;
  pattern?: string;
  enumValues?: string[];
};

export type OutputDefinition = {
  type: ValueType;
  required: boolean;
  description?: string;
};

export type BusinessOutcomeDefinition = {
  code: string;
  description: string;
  when: ConditionDefinition[];
};

export type ApplicationCompatibility = {
  vendor: string;
  application: string;
  supportedVersions?: string[];
  fingerprint?: SurfaceFingerprint;
};

export type SurfaceFingerprint = {
  titlePatterns?: string[];
  routePatterns?: string[];
  landmarks?: string[];
};

export type LocatorStrategy =
  | AccessibleLocator
  | LabelLocator
  | TextLocator
  | RelativeLocator
  | StructuralLocator
  | FrameLocator
  | CoordinatesLocator;

export type AccessibleLocator = {
  strategy: "accessible";
  role: string;
  name: string;
};

export type LabelLocator = {
  strategy: "label";
  text: string;
};

export type TextLocator = {
  strategy: "text";
  text: string;
  exact?: boolean;
};

export type RelativeLocator = {
  strategy: "relative";
  anchorText: string;
  direction: "above" | "below" | "left-of" | "right-of" | "near";
  controlType?: string;
};

export type StructuralLocator = {
  strategy: "structural";
  description: string;
  containerText?: string;
  rowText?: string;
  columnText?: string;
  controlText?: string;
};

export type FrameLocator = {
  strategy: "frame";
  frameName?: string;
  frameTitle?: string;
  child: LocatorStrategy;
};

export type CoordinatesLocator = {
  strategy: "coordinates";
  x: number;
  y: number;
  coordinateSystem: "viewport" | "screen";
};

export type TargetDescriptor = {
  id?: string;
  description?: string;
  primary: LocatorStrategy;
  fallbacks?: LocatorStrategy[];
};

export const stepActions = ["navigate", "click", "fill", "select", "extract", "wait"] as const;

export type StepAction = (typeof stepActions)[number];

export type ValueSource =
  | { parameter: string }
  | { literal: string | number | boolean | MoneyValue };

export type WaitDefinition =
  | { type: "navigation"; timeoutMs?: number }
  | { type: "element"; target: TargetDescriptor; state: "visible" | "hidden"; timeoutMs?: number }
  | { type: "text"; text: string; timeoutMs?: number }
  | { type: "checkpoint"; timeoutMs?: number };

export type ConditionDefinition =
  | { type: "url_contains"; value: string }
  | { type: "title_contains"; value: string }
  | { type: "text_present"; value: string }
  | { type: "target_visible"; target: TargetDescriptor }
  | { type: "output_present"; output: string };

export type OutputExtraction = {
  name: string;
  parseAs: ValueType;
  source?: TargetDescriptor;
};

export type StepRecovery = {
  retries?: {
    maxAttempts: number;
    backoffMs: number;
  };
  knownDialogs?: Array<{
    title: string;
    response: "dismiss" | "accept" | "route_to_human";
  }>;
  onFailure?: {
    class: FailureClass;
    routeToHuman?: boolean;
  };
};

export type CapabilityStep = {
  id: string;
  action: StepAction;
  target?: TargetDescriptor;
  value?: ValueSource;
  risk?: "READ_ONLY" | "REVERSIBLE_WRITE" | "IRREVERSIBLE_WRITE";
  wait?: WaitDefinition;
  precondition?: ConditionDefinition[];
  postcondition?: ConditionDefinition[];
  output?: OutputExtraction;
  recovery?: StepRecovery;
};

export type CheckpointDefinition = {
  description: string;
  conditions: ConditionDefinition[];
};

export type CapabilityPolicy = {
  allowedOrigins: string[];
  allowedRoutes: string[];
  allowedActions: StepAction[];
  risk: "READ_ONLY" | "REVERSIBLE_WRITE" | "IRREVERSIBLE_WRITE";
  approvalRequired?: boolean;
};

export type CapabilityValidation = {
  runs: number;
  successes: number;
  failures: number;
  primaryLocatorUsage: number;
  fallbackLocatorUsage: number;
  lastValidatedAt: string;
};

export type CapabilityArtifact = {
  schemaVersion: string;
  capability: {
    id: string;
    version: string;
    name: string;
    description: string;
    status: CapabilityStatus;
  };
  targetApplication: ApplicationCompatibility;
  inputs: Record<string, InputDefinition>;
  outputs: Record<string, OutputDefinition>;
  outcomes: BusinessOutcomeDefinition[];
  steps: CapabilityStep[];
  checkpoint: CheckpointDefinition;
  policy: CapabilityPolicy;
  validation?: CapabilityValidation;
};
