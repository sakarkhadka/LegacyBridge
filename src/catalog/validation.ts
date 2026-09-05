import type { CapabilityArtifact, CapabilityValidation } from "../artifact/types.js";
import { MemoryEvidenceSink, EvidenceRecorder } from "../evidence/recorder.js";
import { replayCapability } from "../replay/executor.js";

export type CapabilityValidationReport = {
  capabilityId: string;
  version: string;
  runs: number;
  successes: number;
  failures: number;
  primaryLocatorUsage: number;
  fallbackLocatorUsage: number;
  status: "eligible-for-approval" | "needs-review";
  validation: CapabilityValidation;
};

export async function validateCapabilityStability(options: {
  capability: CapabilityArtifact;
  origin: string;
  runs: number;
  inputsForRun: (runNumber: number) => Record<string, unknown>;
  headless?: boolean;
}): Promise<CapabilityValidationReport> {
  let successes = 0;
  let failures = 0;
  let primaryLocatorHits = 0;
  let fallbackLocatorHits = 0;

  for (let index = 0; index < options.runs; index += 1) {
    const sink = new MemoryEvidenceSink();
    const recorder = new EvidenceRecorder({
      runId: `validation-${Date.now()}-${index}`,
      capabilityId: options.capability.capability.id,
      sensitiveValues: Object.values(options.inputsForRun(index + 1)).map(String),
      sink
    });
    const summary = await replayCapability({
      capability: options.capability,
      inputs: options.inputsForRun(index + 1),
      origin: options.origin,
      headless: options.headless,
      evidence: recorder
    });

    if (summary.result.status === "success") {
      successes += 1;
    } else {
      failures += 1;
    }

    for (const event of sink.events) {
      if (event.event !== "target_resolved") {
        continue;
      }
      const target = (event.data as { target?: { fallbackUsed?: boolean } } | undefined)?.target;
      if (!target) {
        continue;
      }
      if (target.fallbackUsed) {
        fallbackLocatorHits += 1;
      } else {
        primaryLocatorHits += 1;
      }
    }
  }

  const locatorHits = primaryLocatorHits + fallbackLocatorHits;
  const validation: CapabilityValidation = {
    runs: options.runs,
    successes,
    failures,
    primaryLocatorUsage: locatorHits === 0 ? 0 : primaryLocatorHits / locatorHits,
    fallbackLocatorUsage: locatorHits === 0 ? 0 : fallbackLocatorHits / locatorHits,
    lastValidatedAt: new Date().toISOString()
  };

  return {
    capabilityId: options.capability.capability.id,
    version: options.capability.capability.version,
    runs: options.runs,
    successes,
    failures,
    primaryLocatorUsage: validation.primaryLocatorUsage,
    fallbackLocatorUsage: validation.fallbackLocatorUsage,
    status: failures === 0 ? "eligible-for-approval" : "needs-review",
    validation
  };
}
