import type { Page } from "playwright";
import { copyFile, mkdir } from "node:fs/promises";
import { createDemoAppServer } from "../../demo-app/server.js";
import { loadCapabilityArtifact, loadCapabilityArtifactFromPath, saveCapabilityArtifact } from "../artifact/loader.js";
import { runDiscovery } from "../discovery/agent.js";
import { compileDiscoveryToArtifact } from "../discovery/artifact-compiler.js";
import { OpenAIDiscoveryModel, ScriptedDiscoveryModel } from "../discovery/model.js";
import { EvidenceRecorder, JsonlEvidenceSink, resetJsonlEvidenceFile } from "../evidence/recorder.js";
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
  "evidence",
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
} else if (command === "evidence") {
  await runEvidenceCommand(process.argv.slice(3));
} else {
  console.log(`LegacyBridge command scaffold: ${command}`);
  console.log("Implementation pending. See status.md for current progress.");
}

function printHelp(): void {
  console.log("LegacyBridge CLI");
  console.log("Commands: compile-discovery, discover, evidence, replay, handoff, validate-capability");
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
  console.log("");
  console.log("Evidence example:");
  console.log("  npm run demo:evidence");
}

async function runDiscoverCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const port = Number(options.port ?? "3103");
  const origin = `http://127.0.0.1:${port}`;
  const goal = options.goal ?? "Look up member 12345 and return their current savings balance.";
  const evidence = options.evidencePath
    ? await createJsonlRecorder(options.evidencePath, {
      runId: `discovery-${Date.now()}`,
      capabilityId: "member.get-savings-balance",
      sensitiveValues: [extractMemberIdFromGoal(goal)].filter((value): value is string => Boolean(value))
    })
    : undefined;
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
      timeoutMs: Number(options.timeoutMs ?? "120000"),
      evidence
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
  const evidence = options.evidencePath
    ? await createJsonlRecorder(options.evidencePath, {
      runId: `replay-${Date.now()}`,
      capabilityId,
      sensitiveValues: [memberId]
    })
    : undefined;
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
      headless: options.headless !== "false",
      evidence
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
  const evidence = options.evidencePath
    ? await createJsonlRecorder(options.evidencePath, {
      runId: `handoff-${Date.now()}`,
      capabilityId: "member.get-savings-balance",
      sensitiveValues: [memberId]
    })
    : undefined;
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
    await evidence?.record("run_started", {
      payload: {
        mode: "handoff",
        trigger: "SESSION_EXPIRED"
      }
    });
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
    await evidence?.record("intervention_created", {
      stepId: intervention.currentStepId,
      payload: {
        intervention
      }
    });

    manager.takeHumanControl();
    await evidence?.record("control_transferred", {
      payload: {
        transition: manager.evidence().ownershipTransitions.at(-1)
      }
    });
    const blockedAutomationMessage = captureBlockedAutomation(manager);

    await evidence?.record("human_action", {
      payload: {
        humanAction: manager.recordHumanInput("Operator reauthentication member hint", memberId)
      }
    });
    await evidence?.record("human_action", {
      payload: {
        humanAction: manager.recordHumanClick("Start New Session")
      }
    });
    await session.page.getByRole("link", { name: "Start New Session" }).click();
    await evidence?.record("human_action", {
      payload: {
        humanAction: manager.recordHumanNavigation(`${origin}/servicing/search`)
      }
    });

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
    await evidence?.record("automation_resumed", {
      payload: {
        resume,
        transition: manager.evidence().ownershipTransitions.at(-1)
      }
    });

    manager.assertAutomationMayAct();
    const balance = await continueSavingsLookup({
      adapter,
      page: session.page,
      memberId
    });
    manager.complete();
    await evidence?.record("run_completed", {
      payload: {
        sameSessionRetained: session.id === adapter.getSession().id,
        finalAutomationResult: {
          balance
        }
      }
    });

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

async function runEvidenceCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const basePort = Number(options.port ?? "3150");

  await runDiscoverCommand([
    "--scripted",
    "--port",
    String(basePort),
    "--evidencePath",
    "evidence/discovery-success/run.jsonl"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 1),
    "--memberId",
    "54321",
    "--evidencePath",
    "evidence/replay-success/run.jsonl"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 2),
    "--memberId",
    "00000",
    "--evidencePath",
    "evidence/replay-business-outcome/run.jsonl"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 3),
    "--memberId",
    "54321",
    "--scenario",
    "interstitial",
    "--evidencePath",
    "evidence/replay-recovery/run.jsonl"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 4),
    "--memberId",
    "88888",
    "--evidencePath",
    "evidence/replay-failure/run.jsonl"
  ]);
  await runHandoffCommand([
    "--port",
    String(basePort + 5),
    "--memberId",
    "54321",
    "--evidencePath",
    "evidence/human-handoff/run.jsonl"
  ]);
  await mkdir("evidence/artifacts", { recursive: true });
  await copyFile("capabilities/member-get-savings-balance.v1.yaml", "evidence/artifacts/member-get-savings-balance.v1.yaml");

  console.log(JSON.stringify({
    status: "evidence_generated",
    files: [
      "evidence/discovery-success/run.jsonl",
      "evidence/replay-success/run.jsonl",
      "evidence/replay-business-outcome/run.jsonl",
      "evidence/replay-recovery/run.jsonl",
      "evidence/replay-failure/run.jsonl",
      "evidence/human-handoff/run.jsonl",
      "evidence/artifacts/member-get-savings-balance.v1.yaml"
    ]
  }, null, 2));
}

async function createJsonlRecorder(path: string, options: {
  runId: string;
  capabilityId: string;
  sensitiveValues: string[];
}): Promise<EvidenceRecorder> {
  await resetJsonlEvidenceFile(path);
  return new EvidenceRecorder({
    ...options,
    sink: new JsonlEvidenceSink(path)
  });
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
