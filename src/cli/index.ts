import type { Page } from "playwright";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDemoAppServer, type DemoAppServer } from "../../demo-app/server.js";
import { loadCapabilityArtifact, loadCapabilityArtifactFromPath, saveCapabilityArtifact } from "../artifact/loader.js";
import type { CapabilityArtifact } from "../artifact/types.js";
import { createCapabilityCatalogServer } from "../catalog/catalog-server.js";
import { validateCapabilityStability } from "../catalog/validation.js";
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
  "catalog",
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
} else if (command === "validate-capability") {
  await runValidateCapabilityCommand(process.argv.slice(3));
} else if (command === "catalog") {
  await runCatalogCommand(process.argv.slice(3));
} else {
  printHelp();
}

function printHelp(): void {
  console.log("LegacyBridge CLI");
  console.log("Commands: catalog, compile-discovery, discover, evidence, replay, handoff, validate-capability");
  console.log("");
  console.log("Replay example:");
  console.log("  npm run replay -- --capability member.get-account-balances --memberId 54321");
  console.log("  npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234");
  console.log("  npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted");
  console.log("  npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted");
  console.log("  npm run replay -- --capabilityPath capabilities/generated/member-get-account-balances.draft.yaml --memberId 54321");
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
  console.log("");
  console.log("Validation example:");
  console.log("  npm run validate-capability -- member.get-account-balances --runs 5");
  console.log("");
  console.log("Catalog example:");
  console.log("  npm run demo:catalog");
}

async function runDiscoverCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const port = Number(options.port ?? "3103");
  const origin = `http://127.0.0.1:${port}`;
  const goal = options.goal ?? "Look up member 12345 and return every available account balance.";
  const evidence = options.evidencePath
    ? await createJsonlRecorder(options.evidencePath, {
      runId: `discovery-${Date.now()}`,
      capabilityId: "member.get-account-balances",
      sensitiveValues: [extractMemberIdFromGoal(goal)].filter((value): value is string => Boolean(value))
    })
    : undefined;
  const server = createCliDemoAppServer(options);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const session = await createPlaywrightSession({
    headless: options.headless !== "false"
  });

  try {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const model = options.scripted === "true" || !process.env.OPENAI_API_KEY
      ? new ScriptedDiscoveryModel(scriptedAccountBalanceLookupDecisions(origin))
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
  const capabilityId = options.capability ?? "member.get-account-balances";
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
  const server = createCliDemoAppServer(options);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  try {
    const capability = options.capabilityPath
      ? await loadCapabilityArtifactFromPath(options.capabilityPath)
      : await loadCapabilityArtifact(capabilityId);
    const summary = await replayCapability({
      capability,
      inputs: replayInputs(options, memberId),
      origin,
      scenario: options.scenario,
      headless: options.headless !== "false",
      evidence,
      approvalGranted: options.approvalGranted === "true"
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
  const goal = options.goal ?? "Look up member 12345 and return every available account balance.";
  const outputPath = options.output ?? "capabilities/generated/member-get-account-balances.draft.yaml";
  const server = createCliDemoAppServer(options);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const session = await createPlaywrightSession({
    headless: options.headless !== "false"
  });

  try {
    const policyCapability = await loadCapabilityArtifact("member.get-account-balances");
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const model = new ScriptedDiscoveryModel(scriptedAccountBalanceLookupDecisions(origin));
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
      capabilityId: "member.get-account-balances",
      sensitiveValues: [memberId]
    })
    : undefined;
  const server = createCliDemoAppServer(options);

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
      capabilityId: "member.get-account-balances",
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
    const accountBalances = await continueAccountBalanceLookup({
      adapter,
      page: session.page,
      memberId
    });
    manager.complete();
    await evidence?.record("run_completed", {
      payload: {
        sameSessionRetained: session.id === adapter.getSession().id,
        finalAutomationResult: {
          accountBalances
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
        accountBalances
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
    "evidence/discovery-success/run.jsonl",
    "--ephemeralState"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 1),
    "--memberId",
    "54321",
    "--evidencePath",
    "evidence/replay-success/run.jsonl",
    "--ephemeralState"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 2),
    "--memberId",
    "00000",
    "--evidencePath",
    "evidence/replay-business-outcome/run.jsonl",
    "--ephemeralState"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 3),
    "--memberId",
    "54321",
    "--scenario",
    "interstitial",
    "--evidencePath",
    "evidence/replay-recovery/run.jsonl",
    "--ephemeralState"
  ]);
  await runReplayCommand([
    "--port",
    String(basePort + 4),
    "--memberId",
    "88888",
    "--evidencePath",
    "evidence/replay-failure/run.jsonl",
    "--ephemeralState"
  ]);
  await runHandoffCommand([
    "--port",
    String(basePort + 5),
    "--memberId",
    "54321",
    "--evidencePath",
    "evidence/human-handoff/run.jsonl",
    "--ephemeralState"
  ]);
  await mkdir("evidence/artifacts", { recursive: true });
  await copyFile("capabilities/member-get-account-balances.v1.yaml", "evidence/artifacts/member-get-account-balances.v1.yaml");
  await copyFile("capabilities/member-deposit-to-account.v1.yaml", "evidence/artifacts/member-deposit-to-account.v1.yaml");
  await copyFile("capabilities/member-withdraw-from-account.v1.yaml", "evidence/artifacts/member-withdraw-from-account.v1.yaml");
  await copyFile("capabilities/member-get-transaction-history.v1.yaml", "evidence/artifacts/member-get-transaction-history.v1.yaml");

  console.log(JSON.stringify({
    status: "evidence_generated",
    files: [
      "evidence/discovery-success/run.jsonl",
      "evidence/replay-success/run.jsonl",
      "evidence/replay-business-outcome/run.jsonl",
      "evidence/replay-recovery/run.jsonl",
      "evidence/replay-failure/run.jsonl",
      "evidence/human-handoff/run.jsonl",
      "evidence/artifacts/member-get-account-balances.v1.yaml",
      "evidence/artifacts/member-deposit-to-account.v1.yaml",
      "evidence/artifacts/member-withdraw-from-account.v1.yaml",
      "evidence/artifacts/member-get-transaction-history.v1.yaml"
    ]
  }, null, 2));
}

async function runValidateCapabilityCommand(args: string[]): Promise<void> {
  const positional = args.filter((arg) => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--"));
  const options = parseArgs(args);
  const capabilityId = positional[0] ?? options.capability ?? "member.get-account-balances";
  const runs = Number(options.runs ?? "5");
  const memberId = options.memberId ?? "54321";
  const port = Number(options.port ?? "3106");
  const origin = `http://127.0.0.1:${port}`;
  const server = createCliDemoAppServer(options);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  try {
    const capability = options.capabilityPath
      ? await loadCapabilityArtifactFromPath(options.capabilityPath)
      : await loadCapabilityArtifact(capabilityId);
    const report = await validateCapabilityStability({
      capability,
      origin,
      runs,
      headless: options.headless !== "false",
      inputsForRun: () => ({
        ...replayInputs(options, memberId)
      })
    });
    const validatedCapability = {
      ...capability,
      validation: report.validation
    };
    const outputPath = options.output ?? defaultCapabilityPath(capabilityId);
    await saveCapabilityArtifact(outputPath, validatedCapability);

    console.log([
      `Capability: ${report.capabilityId}`,
      `Version: ${report.version}`,
      "",
      `Runs: ${report.runs}`,
      `Successes: ${report.successes}`,
      `Failures: ${report.failures}`,
      "",
      `Primary locator usage: ${formatPercent(report.primaryLocatorUsage)}`,
      `Fallback locator usage: ${formatPercent(report.fallbackLocatorUsage)}`,
      "",
      `Status: ${report.status}`,
      `Validation stored: ${outputPath}`
    ].join("\n"));
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

async function runCatalogCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const demoPort = Number(options.demoPort ?? "3107");
  const catalogPort = options.catalogPort ? Number(options.catalogPort) : undefined;
  const memberId = options.memberId ?? "54321";
  const origin = `http://127.0.0.1:${demoPort}`;
  const demoServer = createCliDemoAppServer(options);

  await new Promise<void>((resolve) => {
    demoServer.listen(demoPort, "127.0.0.1", resolve);
  });

  const loaded = await loadCapabilityArtifact("member.get-account-balances");
  const capability = options.approved === "false" ? loaded : withCapabilityStatus(loaded, "approved");
  const catalog = await createCapabilityCatalogServer({
    capabilities: [capability],
    replayOrigin: origin,
    port: catalogPort
  });

  try {
    if (options.smoke !== "false") {
      const capabilities = await fetchJson(`${catalog.url}/capabilities`);
      const invocation = await fetchJson(`${catalog.url}/capabilities/member.get-account-balances/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          memberId
        })
      });
      console.log(JSON.stringify(redactStructuredValue({
        status: "catalog_smoke_completed",
        catalogUrl: catalog.url,
        capabilities,
        invocation
      }, [memberId]), null, 2));
      return;
    }

    console.log(`Capability catalog listening at ${catalog.url}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise<void>(() => undefined);
  } finally {
    await catalog.close();
    await new Promise<void>((resolve, reject) => {
      demoServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function withCapabilityStatus(
  capability: CapabilityArtifact,
  status: CapabilityArtifact["capability"]["status"]
): CapabilityArtifact {
  return {
    ...structuredClone(capability),
    capability: {
      ...capability.capability,
      status
    }
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  return response.json();
}

function defaultCapabilityPath(capabilityId: string): string {
  if (capabilityId === "member.get-account-balances" || capabilityId === "member.get-savings-balance") {
    return join("capabilities", "member-get-account-balances.v1.yaml");
  }
  if (capabilityId === "member.deposit-to-account") {
    return join("capabilities", "member-deposit-to-account.v1.yaml");
  }
  if (capabilityId === "member.withdraw-from-account") {
    return join("capabilities", "member-withdraw-from-account.v1.yaml");
  }
  if (capabilityId === "member.get-transaction-history") {
    return join("capabilities", "member-get-transaction-history.v1.yaml");
  }
  return join("capabilities", `${capabilityId}.yaml`);
}

function replayInputs(options: Record<string, string>, memberId: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      memberId,
      accountNumber: options.accountNumber,
      accountType: options.accountType,
      amount: options.amount
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function createCliDemoAppServer(options: Record<string, string>): DemoAppServer {
  return createDemoAppServer({
    persistState: options.ephemeralState !== "true",
    statePath: options.statePath
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
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

async function continueAccountBalanceLookup(options: {
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

  const balancesTable = await adapter.locate({
    description: "Accounts table with all available balances",
    primary: {
      strategy: "structural",
      description: "Full Accounts table containing account type, account number, and balance columns",
      columnText: "Balance"
    }
  });
  const extracted = await adapter.act({
    type: "extract"
  }, balancesTable);
  return extracted.observed ? parseOutput(extracted.observed, "accountBalances") : undefined;
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

function scriptedAccountBalanceLookupDecisions(origin: string) {
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
      reason: "The accounts frame is visible and contains the balances table.",
      action: {
        type: "extract" as const,
        target: {
          description: "Accounts table with all available balances",
          primary: {
            strategy: "structural" as const,
            description: "Full Accounts table containing account type, account number, and balance columns",
            columnText: "Balance"
          }
        }
      }
    },
    {
      type: "goal_complete" as const,
      reason: "The account balances have been extracted from the member account table.",
      outputs: {
        accountBalances: "Account Type\tAccount Number\tBalance\tActions\nSavings\tS-100234\t$3,182.46\tDeposit Withdraw Transactions\nChecking\tC-442910\t$842.10\tDeposit Withdraw Transactions"
      }
    }
  ];
}
