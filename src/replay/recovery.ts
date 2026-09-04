import type { CapabilityStep } from "../artifact/types.js";

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

