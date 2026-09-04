import type { Page } from "playwright";
import { createDemoAppServer } from "../../demo-app/server.js";
import { loadCapabilityArtifact, loadCapabilityArtifactFromPath, saveCapabilityArtifact } from "../artifact/loader.js";
import { runDiscovery } from "../discovery/agent.js";
import { compileDiscoveryToArtifact } from "../discovery/artifact-compiler.js";
import { OpenAIDiscoveryModel, ScriptedDiscoveryModel } from "../discovery/model.js";
import { InterventionManager } from "../intervention/intervention-manager.js";
import { createOperatorServer } from "../intervention/operator-server.js";
import { redactStructuredValue } from "../policy/redaction.js";
import { waitForDefinition } from "../replay/checkpoint-engine.js";
import { replayCapability } from "../replay/executor.js";
import { parseOutput } from "../replay/output-extractor.js";
import { PlaywrightSurfaceAdapter } from "../surface/playwright/playwright-adapter.js";
import { createPlaywrightSession } from "../surface/playwright/session.js";

const command = process.argv[2] ?? "help";

const knownCommands = new Set([
  "compile-discovery",
  "discover",
  "replay",
  "handoff",
  "validate-capability",
  "help"
]);

if (!knownCommands.has(command)) {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
} else if (command === "help") {
  printHelp();
} else if (command === "replay") {
  await runReplayCommand(process.argv.slice(3));
} else if (command === "discover") {
  await runDiscoverCommand(process.argv.slice(3));
} else if (command === "compile-discovery") {
  await runCompileDiscoveryCommand(process.argv.slice(3));
} else if (command === "handoff") {
  await runHandoffCommand(process.argv.slice(3));
} else {
  console.log(`LegacyBridge command scaffold: ${command}`);
  console.log("Implementation pending. See status.md for current progress.");
}

function printHelp(): void {
  console.log("LegacyBridge CLI");
  console.log("Commands: compile-discovery, discover, replay, handoff, validate-capability");
  console.log("");
  console.log("Replay example:");
  console.log("  npm run replay -- --capability member.get-savings-balance --memberId 54321");
  console.log("  npm run replay -- --capabilityPath capabilities/generated/member-get-savings-balance.draft.yaml --memberId 54321");
  console.log("");
  console.log("Discovery example:");
  console.log("  npm run demo:discover -- --scripted");
  console.log("  npm run demo:compile");
  console.log("");
  console.log("Handoff example:");
  console.log("  npm run demo:handoff");
}

async function runDiscoverCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const port = Number(options.port ?? "3103");
  const origin = `http://127.0.0.1:${port}`;
  const goal = options.goal ?? "Look up member 12345 and return their current savings balance.";
  const server = createDemoAppServer();

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const session = await createPlaywrightSession({
    headless: options.headless !== "false"
  });

  try {
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const model = options.scripted === "true" || !process.env.OPENAI_API_KEY
      ? new ScriptedDiscoveryModel(scriptedSavingsLookupDecisions(origin))
      : new OpenAIDiscoveryModel({
        model: options.model
      });

    const result = await runDiscovery({
      goal,
      entrypoint: `${origin}/servicing/search`,
      surface,
      model,
      policyCapability: capability,
      maxSteps: Number(options.maxSteps ?? "6"),
      timeoutMs: Number(options.timeoutMs ?? "120000")
    });

    const sensitiveValues = [extractMemberIdFromGoal(goal)].filter((value): value is string => Boolean(value));
    console.log(JSON.stringify(redactStructuredValue(result, sensitiveValues), null, 2));
  } finally {
    await session.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function extractMemberIdFromGoal(goal: string): string | undefined {
  return goal.match(/\b[0-9]{5}\b/)?.[0];
}

async function runReplayCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const capabilityId = options.capability ?? "member.get-savings-balance";
  const memberId = options.memberId ?? "54321";
  const port = Number(options.port ?? "3101");
  const origin = `http://127.0.0.1:${port}`;
  const server = createDemoAppServer();

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  try {
    const capability = options.capabilityPath
      ? await loadCapabilityArtifactFromPath(options.capabilityPath)
      : await loadCapabilityArtifact(capabilityId);
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId
      },
      origin,
      scenario: options.scenario,
      headless: options.headless !== "false"
    });

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function runCompileDiscoveryCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const port = Number(options.port ?? "3104");
  const origin = `http://127.0.0.1:${port}`;
  const goal = options.goal ?? "Look up member 12345 and return their current savings balance.";
  const outputPath = options.output ?? "capabilities/generated/member-get-savings-balance.draft.yaml";
  const server = createDemoAppServer();

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const session = await createPlaywrightSession({
    headless: options.headless !== "false"
  });

  try {
    const policyCapability = await loadCapabilityArtifact("member.get-savings-balance");
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const model = new ScriptedDiscoveryModel(scriptedSavingsLookupDecisions(origin));
    const discovery = await runDiscovery({
      goal,
      entrypoint: `${origin}/servicing/search`,
      surface,
      model,
      policyCapability,
      maxSteps: Number(options.maxSteps ?? "6"),
      timeoutMs: Number(options.timeoutMs ?? "120000")
    });
    const artifact = compileDiscoveryToArtifact({
      goal,
      run: discovery
    });
    await saveCapabilityArtifact(outputPath, artifact);

    const sensitiveValues = [extractMemberIdFromGoal(goal)].filter((value): value is string => Boolean(value));
    console.log(JSON.stringify(redactStructuredValue({
      status: "compiled",
      outputPath,
      discovery: {
        status: discovery.status,
        stopReason: discovery.stopReason,
        stepsExecuted: discovery.stepsExecuted,
        modelDecisionCalls: discovery.modelDecisionCalls
      },
      artifact: {
        id: artifact.capability.id,
        status: artifact.capability.status,
        inputNames: Object.keys(artifact.inputs),
        outputNames: Object.keys(artifact.outputs),
        stepIds: artifact.steps.map((step) => step.id),
        checkpoint: artifact.checkpoint
      }
    }, sensitiveValues), null, 2));
  } finally {
    await session.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function runHandoffCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const port = Number(options.port ?? "3105");
  const origin = `http://127.0.0.1:${port}`;
  const memberId = options.memberId ?? "54321";
  const server = createDemoAppServer();

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const session = await createPlaywrightSession({
    headless: options.headless !== "false"
  });
  const adapter = new PlaywrightSurfaceAdapter({
    page: session.page,
    sessionId: session.id,
    evidenceDir: "evidence/tmp/handoff"
  });
  const manager = new InterventionManager({
    sensitiveValues: [memberId]
  });
  const operator = await createOperatorServer(manager);

  try {
    manager.assertAutomationMayAct();
    await adapter.act({
      type: "navigate",
      value: `${origin}/servicing/search?scenario=session-expired`
    });

    const intervention = await manager.trigger({
      runId: `handoff-${Date.now()}`,
      capabilityId: "member.get-savings-balance",
      currentStepId: "navigate-to-search",
      reason: "SESSION_EXPIRED",
      currentRoute: session.page.url(),
      lastActionIds: ["navigate-to-search"],
      surface: adapter
    });

    manager.takeHumanControl();
    const blockedAutomationMessage = captureBlockedAutomation(manager);

    manager.recordHumanInput("Operator reauthentication member hint", memberId);
    manager.recordHumanClick("Start New Session");
    await session.page.getByRole("link", { name: "Start New Session" }).click();
    manager.recordHumanNavigation(`${origin}/servicing/search`);

    manager.requestResume();
    const resume = await manager.verifyResume([
      {
        type: "text_present",
        value: "Member Search"
      }
    ], {
      page: session.page,
      adapter,
      outputs: {}
    });

    manager.assertAutomationMayAct();
    const balance = await continueSavingsLookup({
      adapter,
      page: session.page,
      memberId
    });
    manager.complete();

    console.log(JSON.stringify(redactStructuredValue({
      status: "completed",
      operatorUrl: operator.url,
      sameSessionRetained: session.id === adapter.getSession().id,
      blockedAutomationMessage,
      intervention: {
        id: intervention.id,
        reason: intervention.reason,
        currentStepId: intervention.currentStepId,
        currentRoute: intervention.currentRoute,
        screenshot: intervention.screenshot
      },
      resume,
      evidence: manager.evidence(),
      finalAutomationResult: {
        balance
      }
    }, [memberId]), null, 2));
  } finally {
    await operator.close();
    await session.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function captureBlockedAutomation(manager: InterventionManager): string {
  try {
    manager.assertAutomationMayAct();
    return "automation unexpectedly allowed";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function continueSavingsLookup(options: {
  adapter: PlaywrightSurfaceAdapter;
  page: Page;
  memberId: string;
}) {
  const { adapter, memberId, page } = options;
  const memberField = await adapter.locate({
    description: "Member Number field",
    primary: {
      strategy: "label",
      text: "Member Number"
    }
  });
  await adapter.act({
    type: "fill",
    value: memberId
  }, memberField);

  const searchButton = await adapter.locate({
    description: "Search button in the member search form",
    primary: {
      strategy: "relative",
      anchorText: "Member Number",
      direction: "below",
      controlType: "submit button"
    }
  });
  await adapter.act({
    type: "click"
  }, searchButton);
  await waitForDefinition({
    type: "text",
    text: "Accounts",
    timeoutMs: 5000
  }, {
    page,
    adapter,
    outputs: {}
  });

  const balanceCell = await adapter.locate({
    description: "Savings balance cell",
    primary: {
      strategy: "structural",
      description: "Balance cell in the Accounts table for the Savings row",
      rowText: "Savings",
      columnText: "Balance"
    }
  });
  const extracted = await adapter.act({
    type: "extract"
  }, balanceCell);
  return extracted.observed ? parseOutput(extracted.observed, "money") : undefined;
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function scriptedSavingsLookupDecisions(origin: string) {
  return [
    {
      type: "act" as const,
      reason: "The Member Number field is visible on the search screen.",
      action: {
        type: "fill" as const,
        target: {
          description: "Member Number field",
          primary: {
            strategy: "label" as const,
            text: "Member Number"
          },
          fallbacks: [
            {
              strategy: "accessible" as const,
              role: "textbox",
              name: "Member Number"
            }
          ]
        },
        value: "12345"
      }
    },
    {
      type: "act" as const,
      reason: "The search form can be submitted with the Search button near Member Number.",
      action: {
        type: "click" as const,
        target: {
          description: "Search button in the member search form",
          primary: {
            strategy: "relative" as const,
            anchorText: "Member Number",
            direction: "below" as const,
            controlType: "submit button"
          },
          fallbacks: [
            {
              strategy: "accessible" as const,
              role: "button",
              name: "Search"
            }
          ]
        }
      }
    },
    {
      type: "act" as const,
      reason: "The accounts frame is visible and contains the Savings row.",
      action: {
        type: "extract" as const,
        target: {
          description: "Savings balance cell",
          primary: {
            strategy: "structural" as const,
            description: "Balance cell in the Accounts table for the Savings row",
            rowText: "Savings",
            columnText: "Balance"
          }
        }
      }
    },
    {
      type: "goal_complete" as const,
      reason: "The Savings balance has been extracted from the member account table.",
      outputs: {
        balance: "$3,182.46"
      }
    }
  ];
}
