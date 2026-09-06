import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { parseCapabilityArtifact } from "./schema.js";
import type { CapabilityArtifact } from "./types.js";

const capabilityFiles: Record<string, string> = {
  "member.get-account-balances": "member-get-account-balances.v1.yaml",
  "member.get-savings-balance": "member-get-account-balances.v1.yaml"
};

export async function loadCapabilityArtifact(capabilityId: string): Promise<CapabilityArtifact> {
  const fileName = capabilityFiles[capabilityId];
  if (!fileName) {
    throw new Error(`Unknown capability: ${capabilityId}`);
  }

  return loadCapabilityArtifactFromPath(join("capabilities", fileName));
}

export async function loadCapabilityArtifactFromPath(path: string): Promise<CapabilityArtifact> {
  const raw = await readFile(path, "utf8");
  return parseCapabilityArtifact(parse(raw));
}

export async function saveCapabilityArtifact(path: string, artifact: CapabilityArtifact): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const validated = parseCapabilityArtifact(artifact);
  await writeFile(path, stringify(validated, {
    lineWidth: 0
  }), "utf8");
}
