import type { CheckpointDefinition } from "../artifact/types.js";

export function buildDiscoveryCheckpoint(outputName: string): CheckpointDefinition {
  return {
    description: "Savings balance was extracted from the member account table.",
    conditions: [
      {
        type: "output_present",
        output: outputName
      }
    ]
  };
}
