import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { parseCapabilityArtifact } from "./schema.js";
import type { CapabilityArtifact } from "./types.js";

const capabilityFiles: Record<string, string> = {
  "member.get-savings-balance": "member-get-savings-balance.v1.yaml"
};

export async function loadCapabilityArtifact(capabilityId: string): Promise<CapabilityArtifact> {
  const fileName = capabilityFiles[capabilityId];
  if (!fileName) {
    throw new Error(`Unknown capability: ${capabilityId}`);
  }

  const raw = await readFile(join("capabilities", fileName), "utf8");
  return parseCapabilityArtifact(parse(raw));
}

