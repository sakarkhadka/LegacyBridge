import type { SurfaceObservation } from "../surface/types.js";
import type { AgentDecision } from "./decision-schema.js";

export type DiscoveryStopReason =
  | "goal_completed"
  | "max_steps"
  | "timeout"
  | "dead_end"
  | "policy_blocked"
  | "intervention_required"
  | "execution_failed";

export type DiscoveryContext = {
  goal: string;
  stepNumber: number;
  maxSteps: number;
  observation: SurfaceObservation;
  previousActionResult?: unknown;
  allowedActionTypes: string[];
  systemPrompt: string;
  userPrompt: string;
};

export type DiscoveryTraceEvent =
  | {
      type: "observation";
      stepNumber: number;
      observation: SurfaceObservation;
    }
  | {
      type: "model_decision";
      stepNumber: number;
      decision: AgentDecision;
    }
  | {
      type: "action_result";
      stepNumber: number;
      result: unknown;
    };

export type DiscoveryRunResult = {
  status: "success" | "stopped";
  stopReason: DiscoveryStopReason;
  outputs: Record<string, string>;
  stepsExecuted: number;
  trace: DiscoveryTraceEvent[];
  modelDecisionCalls: number;
};

