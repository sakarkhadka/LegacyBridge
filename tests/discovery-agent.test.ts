import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact } from "../src/artifact/loader.js";
import type { CapabilityArtifact } from "../src/artifact/types.js";
import { runDiscovery } from "../src/discovery/agent.js";
import { agentDecisionSchema } from "../src/discovery/decision-schema.js";
import { ScriptedDiscoveryModel } from "../src/discovery/model.js";
import { PlaywrightSurfaceAdapter } from "../src/surface/playwright/playwright-adapter.js";
import { createPlaywrightSession, type PlaywrightSession } from "../src/surface/playwright/session.js";

let server: DemoAppServer;
let session: PlaywrightSession;
let origin: string;
let capability: CapabilityArtifact;

beforeAll(async () => {
  server = createDemoAppServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected demo app to listen on a TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;
  capability = await loadCapabilityArtifact("member.get-savings-balance");
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}, 30_000);

afterEach(async () => {
  await session?.close();
  session = undefined as unknown as PlaywrightSession;
});

async function createSurface() {
  session = await createPlaywrightSession({ headless: true });
  return new PlaywrightSurfaceAdapter({
    page: session.page,
    sessionId: session.id
  });
}

describe("discovery agent", () => {
  it("validates structured model decisions", () => {
    const parsed = agentDecisionSchema.parse({
      type: "act",
      reason: "The field is visible.",
      action: {
        type: "fill",
        target: {
          primary: {
            strategy: "label",
            text: "Member Number"
          }
        },
        value: "12345"
      }
    });

    expect(parsed.type).toBe("act");
    expect(agentDecisionSchema.safeParse({ type: "act", reason: "bad", code: "page.click()" }).success).toBe(false);
  });

  it("runs an observe-decide-act discovery loop against the live UI", async () => {
    const surface = await createSurface();
    const model = new ScriptedDiscoveryModel([
      {
        type: "act",
        reason: "Fill the member number.",
        action: {
          type: "fill",
          target: {
            primary: {
              strategy: "label",
              text: "Member Number"
            }
          },
          value: "12345"
        }
      },
      {
        type: "act",
        reason: "Submit the member search form.",
        action: {
          type: "click",
          target: {
            primary: {
              strategy: "relative",
              anchorText: "Member Number",
              direction: "below",
              controlType: "submit button"
            }
          }
        }
      },
      {
        type: "act",
        reason: "Extract the Savings row balance.",
        action: {
          type: "extract",
          target: {
            primary: {
              strategy: "structural",
              description: "Balance cell in the Accounts table for the Savings row",
              rowText: "Savings",
              columnText: "Balance"
            }
          }
        }
      },
      {
        type: "goal_complete",
        reason: "The savings balance was extracted.",
        outputs: {
          balance: "$3,182.46"
        }
      }
    ]);

    const result = await runDiscovery({
      goal: "Look up member 12345 and return their current savings balance.",
      entrypoint: `${origin}/servicing/search`,
      surface,
      model,
      policyCapability: capability,
      maxSteps: 6
    });

    expect(result.status).toBe("success");
    expect(result.stopReason).toBe("goal_completed");
    expect(result.modelDecisionCalls).toBe(4);
    expect(result.outputs.balance).toBe("$3,182.46");
    expect(result.trace.some((event) => event.type === "observation")).toBe(true);
    expect(result.trace.some((event) => event.type === "model_decision")).toBe(true);
    expect(result.trace.some((event) => event.type === "action_result")).toBe(true);
  }, 30_000);

  it("blocks model-proposed external navigation through policy", async () => {
    const surface = await createSurface();
    const model = new ScriptedDiscoveryModel([
      {
        type: "act",
        reason: "Try leaving the allowlisted app.",
        action: {
          type: "navigate",
          value: "https://example.com/"
        }
      }
    ]);

    const result = await runDiscovery({
      goal: "Leave the app.",
      entrypoint: `${origin}/servicing/search`,
      surface,
      model,
      policyCapability: capability,
      maxSteps: 2
    });

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("policy_blocked");
    expect(JSON.stringify(result.trace)).toContain("not allowlisted");
  }, 30_000);

  it("does not trust unverified goal_complete decisions", async () => {
    const surface = await createSurface();
    const model = new ScriptedDiscoveryModel([
      {
        type: "goal_complete",
        reason: "Claimed too early.",
        outputs: {
          balance: "$3,182.46"
        }
      }
    ]);

    const result = await runDiscovery({
      goal: "Look up member 12345 and return their current savings balance.",
      entrypoint: `${origin}/servicing/search`,
      surface,
      model,
      policyCapability: capability,
      maxSteps: 2
    });

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("execution_failed");
  }, 30_000);
});
