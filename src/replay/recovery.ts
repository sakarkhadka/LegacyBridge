import type { CapabilityStep } from "../artifact/types.js";
import type { PlaywrightSurfaceAdapter } from "../surface/playwright/playwright-adapter.js";

export type RecoveryEvent = {
  stepId: string;
  condition: "KNOWN_INTERSTITIAL" | "TRANSIENT_LOAD";
  action: string;
  recovered: boolean;
};

export function retryAttemptsFor(step: CapabilityStep): number {
  return step.recovery?.retries?.maxAttempts ?? 0;
}

export async function waitBeforeRetry(step: CapabilityStep): Promise<void> {
  const backoffMs = step.recovery?.retries?.backoffMs ?? 0;
  if (backoffMs <= 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, backoffMs);
  });
}

export async function recoverKnownInterstitials(
  step: CapabilityStep,
  adapter: PlaywrightSurfaceAdapter
): Promise<RecoveryEvent[]> {
  const events: RecoveryEvent[] = [];
  const knownDialogs = step.recovery?.knownDialogs ?? [];

  for (const dialog of knownDialogs) {
    const observation = await adapter.observe();
    const pageText = observation.visibleText.join("\n");
    if (!pageText.includes(dialog.title) || !pageText.includes("Maintenance scheduled tonight")) {
      continue;
    }

    if (dialog.response === "dismiss") {
      const dismissTarget = await adapter.locate({
        description: "Dismiss known system notice",
        primary: {
          strategy: "accessible",
          role: "link",
          name: "Dismiss"
        },
        fallbacks: [
          {
            strategy: "text",
            text: "Dismiss",
            exact: true
          }
        ]
      });

      if (dismissTarget.matchCount === 1) {
        await adapter.act({ type: "click" }, dismissTarget);
        events.push({
          stepId: step.id,
          condition: "KNOWN_INTERSTITIAL",
          action: "dismissed System Notice",
          recovered: true
        });
      } else {
        events.push({
          stepId: step.id,
          condition: "KNOWN_INTERSTITIAL",
          action: "attempted to dismiss System Notice",
          recovered: false
        });
      }
    }
  }

  return events;
}
