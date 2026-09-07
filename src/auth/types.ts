import type { Page } from "playwright";
import type { CapabilityArtifact } from "../artifact/types.js";
import type { EvidenceRecorder } from "../evidence/recorder.js";

export type RuntimeAuthContext = {
  origin: string;
  page: Page;
  capability?: CapabilityArtifact;
  inputs?: Record<string, unknown>;
  evidence?: EvidenceRecorder;
};

export type RuntimeAuthResult = {
  authenticated: boolean;
  principal?: string;
  role?: string;
};

export interface RuntimeAuthProvider {
  readonly name: string;
  authenticate(context: RuntimeAuthContext): Promise<RuntimeAuthResult>;
}
