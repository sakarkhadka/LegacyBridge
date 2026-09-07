import type { CheckpointDefinition } from "../artifact/types.js";

export function buildDiscoveryCheckpoint(outputName: string, description = "Account balances were extracted from the member account table."): CheckpointDefinition {
  return {
    description,
    conditions: [
      {
        type: "output_present",
        output: outputName
      }
    ]
  };
}
