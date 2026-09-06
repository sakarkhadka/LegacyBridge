import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact, saveCapabilityArtifact } from "../src/artifact/loader.js";
import { parseCapabilityArtifact } from "../src/artifact/schema.js";
import { compileDiscoveryToArtifact } from "../src/discovery/artifact-compiler.js";
import { runDiscovery } from "../src/discovery/agent.js";
import { ScriptedDiscoveryModel } from "../src/discovery/model.js";
import { replayCapability } from "../src/replay/executor.js";
import { PlaywrightSurfaceAdapter } from "../src/surface/playwright/playwright-adapter.js";
import { createPlaywrightSession, type PlaywrightSession } from "../src/surface/playwright/session.js";

let server: DemoAppServer;
let session: PlaywrightSession;
let origin: string;

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

describe("artifact compiler", () => {
  it("compiles successful discovery into a redacted draft artifact that replays without LLM decisions", async () => {
    const policyCapability = await loadCapabilityArtifact("member.get-account-balances");
    session = await createPlaywrightSession({ headless: true });
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const goal = "Look up member 12345 and return every available account balance.";
    const discovery = await runDiscovery({
      goal,
      entrypoint: `${origin}/servicing/search`,
      surface,
      model: new ScriptedDiscoveryModel([
        {
          type: "act",
          reason: "Fill the member number.",
          action: {
            type: "fill",
            target: {
              description: "Member Number field",
              primary: {
                strategy: "label",
                text: "Member Number"
              },
              fallbacks: [
                {
                  strategy: "accessible",
                  role: "textbox",
                  name: "Member Number"
                }
              ]
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
              description: "Search button in the member search form",
              primary: {
                strategy: "relative",
                anchorText: "Member Number",
                direction: "below",
                controlType: "submit button"
              },
              fallbacks: [
                {
                  strategy: "accessible",
                  role: "button",
                  name: "Search"
                }
              ]
            }
          }
        },
        {
          type: "act",
          reason: "Extract the accounts table.",
          action: {
            type: "extract",
            target: {
              description: "Accounts table with all available balances",
              primary: {
                strategy: "structural",
                description: "Full Accounts table containing account type, account number, and balance columns",
                columnText: "Balance"
              }
            }
          }
        },
        {
          type: "goal_complete",
          reason: "The account balances were extracted.",
          outputs: {
            accountBalances: "Account Type\tAccount Number\tBalance\tAction\nSavings\tS-100234\t$3,182.46\tDetails\nChecking\tC-442910\t$842.10\tDetails"
          }
        }
      ]),
      policyCapability,
      maxSteps: 6
    });

    expect(discovery.status).toBe("success");
    const artifact = compileDiscoveryToArtifact({
      goal,
      run: discovery
    });
    const outputPath = join("capabilities", "generated", "member-get-account-balances.draft.yaml");
    await saveCapabilityArtifact(outputPath, artifact);
    const yaml = await readFile(outputPath, "utf8");

    expect(yaml).not.toContain("12345");
    expect(yaml).not.toContain("S-100234");
    expect(yaml).not.toContain("C-442910");
    expect(artifact.capability.status).toBe("draft");
    expect(artifact.inputs.memberId).toBeDefined();
    expect(artifact.outputs.accountBalances).toBeDefined();
    expect(artifact.steps.length).toBeGreaterThanOrEqual(4);
    expect(artifact.steps.every((step) => step.action === "navigate" || step.target)).toBe(true);
    expect(artifact.checkpoint.conditions).toContainEqual({
      type: "output_present",
      output: "accountBalances"
    });
    expect(() => parseCapabilityArtifact(artifact)).not.toThrow();

    const replay = await replayCapability({
      capability: artifact,
      inputs: {
        memberId: "54321"
      },
      origin
    });

    expect(replay.llmDecisionCalls).toBe(0);
    expect(replay.result.status).toBe("success");
    if (replay.result.status !== "success") {
      throw new Error("Expected replay success");
    }
    expect(replay.result.outputs.accountBalances).toEqual({
      type: "accountBalances",
      value: [
        {
          accountType: "Savings",
          balance: {
            amount: 8044.19,
            currency: "USD"
          }
        },
        {
          accountType: "Checking",
          balance: {
            amount: 12000,
            currency: "USD"
          }
        }
      ]
    });
  }, 30_000);
});
