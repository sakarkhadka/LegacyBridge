import type { CapabilityArtifact, InputDefinition, OutputDefinition } from "../artifact/types.js";

export type PublicCapabilityManifest = {
  name: string;
  description: string;
  inputs: Record<string, PublicInputDefinition>;
  outputs: Record<string, PublicOutputDefinition>;
  risk: CapabilityArtifact["policy"]["risk"];
};

export type PublicInputDefinition = Pick<InputDefinition, "type" | "required" | "description" | "pattern" | "enumValues">;
export type PublicOutputDefinition = Pick<OutputDefinition, "type" | "required" | "description">;

export function publicManifestFor(capability: CapabilityArtifact): PublicCapabilityManifest {
  return {
    name: capability.capability.id,
    description: publicDescription(capability),
    inputs: Object.fromEntries(
      Object.entries(capability.inputs).map(([name, definition]) => [name, publicInput(definition)])
    ),
    outputs: capability.outputs,
    risk: capability.policy.risk
  };
}

function publicInput(definition: InputDefinition): PublicInputDefinition {
  return {
    type: definition.type,
    required: definition.required,
    description: definition.description,
    pattern: definition.pattern,
    enumValues: definition.enumValues
  };
}

function publicDescription(capability: CapabilityArtifact): string {
  if (capability.capability.id === "member.get-savings-balance") {
    return "Retrieve a member's current savings balance.";
  }
  return capability.capability.description;
}
