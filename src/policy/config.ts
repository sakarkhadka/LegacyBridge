import type { CapabilityArtifact } from "../artifact/types.js";
import type { PolicyConfig } from "./types.js";

export function policyConfigFromCapability(capability: CapabilityArtifact, origin: string): PolicyConfig {
  return {
    allowedOrigins: capability.policy.allowedOrigins.map((allowedOrigin) => allowedOrigin.replaceAll("{{origin}}", origin)),
    allowedRoutes: capability.policy.allowedRoutes,
    allowedActions: capability.policy.allowedActions,
    irreversibleActionsRequireHuman: true
  };
}

