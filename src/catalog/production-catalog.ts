import type { CapabilityArtifact } from "../artifact/types.js";
import { replayCapability, type ReplaySummary } from "../replay/executor.js";

export function isProductionInvokable(capability: CapabilityArtifact): boolean {
  return capability.capability.status === "approved" || capability.capability.status === "active";
}

export function assertProductionInvokable(capability: CapabilityArtifact): void {
  if (!isProductionInvokable(capability)) {
    throw new Error(`Capability ${capability.capability.id}@${capability.capability.version} is ${capability.capability.status}; production catalog requires approved or active`);
  }
}

export async function invokeProductionCapability(options: {
  capability: CapabilityArtifact;
  inputs: Record<string, unknown>;
  origin: string;
  scenario?: string;
  headless?: boolean;
}): Promise<ReplaySummary> {
  assertProductionInvokable(options.capability);
  return replayCapability(options);
}
