import type { StepAction } from "../artifact/types.js";
import type { SurfaceObservation } from "../surface/types.js";
import type { DiscoveryContext } from "./run-state.js";

export function buildDiscoveryContext(options: {
  goal: string;
  stepNumber: number;
  maxSteps: number;
  observation: SurfaceObservation;
  previousActionResult?: unknown;
  allowedActionTypes: StepAction[];
}): DiscoveryContext {
  const systemPrompt = [
    "You are a computer-use discovery planner.",
    "Return one structured decision only.",
    "Do not generate JavaScript, Playwright code, CSS selectors, or arbitrary browser code.",
    "Use semantic targets such as label, accessible role/name, text, relative, structural, frame, or coordinates.",
    "Prefer label and accessible targets before coordinates.",
    "For wait or navigate actions, omit target entirely.",
    "For click, fill, select, and extract actions, include target.primary.",
    "Valid locator strategy names are exactly: accessible, label, text, relative, structural, frame, coordinates.",
    "Never use selector, css, xpath, id, querySelector, playwright, or locator as a strategy.",
    "For Member Number, prefer target.primary = { strategy: 'label', text: 'Member Number' }.",
    "For the Search submit button, prefer target.primary = { strategy: 'relative', anchorText: 'Member Number', direction: 'below', controlType: 'submit button' }.",
    "For account balance extraction, prefer target.primary = { strategy: 'structural', description: 'Full Accounts table containing account type, account number, and balance columns' }. Do not wrap this in a frame target.",
    "If the controls observation shows Member Number already has a value, click Search next instead of filling again.",
    "Mark goal_complete only when the requested output is visible in the observation or was returned by the immediately previous extraction.",
    "For account balance goal_complete outputs, use key accountBalances and copy the exact text returned by the previous extraction. Do not return arrays or objects from discovery."
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      goal: options.goal,
      stepNumber: options.stepNumber,
      maxSteps: options.maxSteps,
      allowedActionTypes: options.allowedActionTypes,
      previousActionResult: options.previousActionResult,
      observation: {
        url: options.observation.url,
        title: options.observation.title,
        visibleText: options.observation.visibleText,
        controls: options.observation.controls,
        dialogs: options.observation.dialogs,
        frames: options.observation.frames
      }
    },
    null,
    2
  );

  return {
    goal: options.goal,
    stepNumber: options.stepNumber,
    maxSteps: options.maxSteps,
    observation: options.observation,
    previousActionResult: options.previousActionResult,
    allowedActionTypes: options.allowedActionTypes,
    systemPrompt,
    userPrompt
  };
}
