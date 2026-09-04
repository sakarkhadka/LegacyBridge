export const failureClasses = [
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "PRECONDITION_FAILED",
  "POSTCONDITION_FAILED",
  "CHECKPOINT_FAILED",
  "LOAD_TIMEOUT",
  "SESSION_EXPIRED",
  "PERMISSION_DENIED",
  "UNEXPECTED_DIALOG",
  "APPLICATION_ERROR",
  "POLICY_VIOLATION"
] as const;

export type FailureClass = (typeof failureClasses)[number];

export type ExecutionError = {
  class: FailureClass;
  stepId?: string;
  expected: string;
  observed: string;
  recoverable: boolean;
};

