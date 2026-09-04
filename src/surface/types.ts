import type { StepAction, TargetDescriptor } from "../artifact/types.js";

export type EvidenceReference = {
  id: string;
  kind: "screenshot" | "trace" | "dom_snapshot" | "accessibility_snapshot" | "jsonl";
  path: string;
  redacted: boolean;
};

export type SurfaceObservation = {
  url: string;
  title: string;
  visibleText: string[];
  accessibilityTree?: unknown;
  dialogs: Array<{
    title?: string;
    message: string;
  }>;
  frames: Array<{
    name?: string;
    title?: string;
    url: string;
  }>;
  screenshot?: EvidenceReference;
};

export type ResolvedTarget = {
  descriptor: TargetDescriptor;
  strategyUsed: string;
  confidence: number;
  matchCount: number;
  fallbackUsed: boolean;
};

export type SurfaceAction = {
  type: StepAction;
  value?: unknown;
};

export type ActionResult = {
  ok: boolean;
  observed?: string;
};

export type SessionHandle = {
  id: string;
  surface: "browser" | "desktop" | "vision";
};

export interface SurfaceAdapter {
  observe(): Promise<SurfaceObservation>;
  locate(target: TargetDescriptor): Promise<ResolvedTarget>;
  act(action: SurfaceAction, target?: ResolvedTarget): Promise<ActionResult>;
  captureEvidence(): Promise<EvidenceReference>;
  getSession(): SessionHandle;
}

