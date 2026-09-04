import type { Page } from "playwright";
import type { ConditionDefinition, TargetDescriptor, WaitDefinition } from "../artifact/types.js";
import type { SurfaceAdapter } from "../surface/types.js";
import type { TypedOutput } from "./results.js";

export type ConditionContext = {
  page: Page;
  adapter: SurfaceAdapter;
  outputs: Record<string, TypedOutput>;
};

export async function conditionsPass(conditions: ConditionDefinition[] | undefined, context: ConditionContext): Promise<boolean> {
  if (!conditions || conditions.length === 0) {
    return true;
  }

  for (const condition of conditions) {
    if (!(await conditionPasses(condition, context))) {
      return false;
    }
  }

  return true;
}

export async function conditionPasses(condition: ConditionDefinition, context: ConditionContext): Promise<boolean> {
  switch (condition.type) {
    case "url_contains":
      return context.page.url().includes(condition.value);
    case "title_contains":
      return (await context.page.title()).includes(condition.value);
    case "text_present":
      return pageContainsText(context.page, condition.value);
    case "target_visible":
      return targetIsVisible(context.adapter, condition.target);
    case "output_present":
      return Boolean(context.outputs[condition.output]);
  }
}

export async function waitForDefinition(wait: WaitDefinition | undefined, context: ConditionContext): Promise<boolean> {
  if (!wait) {
    return true;
  }

  const timeoutMs = wait.timeoutMs ?? 5000;

  switch (wait.type) {
    case "navigation":
      await context.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
      return true;
    case "element":
      return pollUntil(async () => (await targetIsVisible(context.adapter, wait.target)) === (wait.state === "visible"), timeoutMs);
    case "text":
      return pollUntil(async () => pageContainsText(context.page, wait.text), timeoutMs);
    case "checkpoint":
      return true;
  }
}

async function pageContainsText(page: Page, text: string): Promise<boolean> {
  for (const frame of page.frames()) {
    const frameText = await frame.locator("body").innerText().catch(() => "");
    if (frameText.includes(text)) {
      return true;
    }
  }
  return false;
}

async function targetIsVisible(adapter: SurfaceAdapter, target: TargetDescriptor): Promise<boolean> {
  const resolved = await adapter.locate(target);
  return resolved.matchCount === 1;
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return false;
}
