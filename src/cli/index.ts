import type { Page } from "playwright";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDemoAppServer, type DemoAppServer } from "../../demo-app/server.js";
import { createRiversideAppServer, type RiversideAppServer } from "../../demo-app/riverside-server.js";
import { loadCapabilityArtifact, loadCapabilityArtifactFromPath, saveCapabilityArtifact } from "../artifact/loader.js";
import type { CapabilityArtifact } from "../artifact/types.js";
import { DemoFormAuthProvider } from "../auth/demo-form-auth-provider.js";
import type { RuntimeAuthProvider } from "../auth/types.js";
import { createCapabilityCatalogServer } from "../catalog/catalog-server.js";
import { validateCapabilityStability } from "../catalog/validation.js";
import { runDiscovery } from "../discovery/agent.js";
import { compileDiscoveryToArtifact, type CompilableCapabilityId } from "../discovery/artifact-compiler.js";
import { OpenAIDiscoveryModel, ScriptedDiscoveryModel } from "../discovery/model.js";
import { EvidenceRecorder, JsonlEvidenceSink, resetJsonlEvidenceFile } from "../evidence/recorder.js";
import { InterventionManager } from "../intervention/intervention-manager.js";
import { createOperatorServer } from "../intervention/operator-server.js";
import { redactStructuredValue } from "../policy/redaction.js";
import { waitForDefinition } from "../replay/checkpoint-engine.js";
import { replayCapability, type ReplayApprovalDecision, type ReplayApprovalRequest } from "../replay/executor.js";
import { parseOutput } from "../replay/output-extractor.js";
import { PlaywrightSurfaceAdapter } from "../surface/playwright/playwright-adapter.js";
import { createPlaywrightSession } from "../surface/playwright/session.js";
import { capabilityPathForTenant, loadTenantProfile } from "../tenant/profile.js";
import type { TenantProfile } from "../tenant/types.js";

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
  console.log("Use --tenant heritage-demo to load origin, auth defaults, and capability paths from tenants/heritage-demo.yaml.");
  console.log("");
  console.log("Replay example:");
  console.log("  npm run replay -- --capability member.get-account-balances --memberId 54321");
  console.log("  npm run replay -- --capability member.get-account-balances --memberId 54321 --origin http://127.0.0.1:3000 --noDemoServer");
  console.log("  npm run replay -- --capability member.get-account-balances --memberId 54321 --runtimeUser read --runtimePassword r123");
  console.log("  npm run replay -- --capability member.get-transaction-history --memberId 12345 --accountNumber S-100234");
  console.log("  npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --approvalGranted");
  console.log("  npm run replay -- --capability member.deposit-to-account --memberId 12345 --accountNumber S-100234 --amount 25.00 --interactive");
  console.log("  npm run replay -- --capability member.withdraw-from-account --memberId 12345 --accountNumber C-442910 --amount 10.00 --approvalGranted");
  console.log("  npm run replay -- --capabilityPath capabilities/generated/member-get-account-balances.draft.yaml --memberId 54321");
  console.log("");
  console.log("Discovery example:");
  console.log("  npm run demo:discover -- --scripted");
  console.log("  npm run demo:compile");
  console.log("  npm run demo:compile -- --capability member.get-account-balances");
  console.log("  npm run demo:compile -- --capability member.deposit-to-account");
  console.log("  npm run demo:compile -- --capability member.withdraw-from-account");
  console.log("  npm run demo:compile -- --capability member.get-transaction-history");
  console.log("");
  console.log("Handoff example:");
  console.log("  npm run demo:handoff");
  console.log("  npm run demo:handoff -- --interactive --handoffTtlSeconds 60");
  console.log("");
  console.log("Evidence example:");
  console.log("  npm run demo:evidence");
  console.log("");
  console.log("Validation example:");
  console.log("  npm run validate-capability -- member.get-account-balances --runs 5");
  console.log("  npm run validate-capability -- member.get-transaction-history --runs 5 --memberId 12345 --accountNumber S-100234");
  console.log("  npm run validate-capability -- member.deposit-to-account --runs 3 --memberId 12345 --accountNumber S-100234 --amount 1.00 --approvalGranted --ephemeralState");
  console.log("");
  console.log("Catalog example:");
  console.log("  npm run demo:catalog");
}

async function runDiscoverCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const tenant = await tenantProfileFromOptions(options);
  const targetApp = await prepareTargetApp(options, 3103, tenant);
  const origin = targetApp.origin;
  const goal = options.goal ?? "Look up member 12345 and return every available account balance.";
  const evidence = options.evidencePath
    ? await createJsonlRecorder(options.evidencePath, {
      runId: `discovery-${Date.now()}`,
      capabilityId: "member.get-account-balances",
      sensitiveValues: [extractMemberIdFromGoal(goal)].filter((value): value is string => Boolean(value))
    })
    : undefined;
  const session = await createPlaywrightSession({
    headless: headlessFromOptions(options)
  });
  const authProvider = authProviderFromOptions(options, tenant);

  try {
    const capability = await loadCapabilityForOptions("member.get-account-balances", options, tenant);
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const model = options.scripted === "true" || !process.env.OPENAI_API_KEY
      ? new ScriptedDiscoveryModel(scriptedAccountBalanceLookupDecisions())
      : new OpenAIDiscoveryModel({
        model: options.model
      });
    await authProvider?.authenticate({
      origin,
      page: session.page,
      capability,
      evidence
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
    await targetApp.close();
  }
}

function extractMemberIdFromGoal(goal: string): string | undefined {
  return goal.match(/\b[0-9]{5}\b/)?.[0];
}

async function runReplayCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const tenant = await tenantProfileFromOptions(options);
  const capabilityId = options.capability ?? "member.get-account-balances";
  const memberId = defaultMemberId(options, tenant);
  const evidence = options.evidencePath
    ? await createJsonlRecorder(options.evidencePath, {
      runId: `replay-${Date.now()}`,
      capabilityId,
      sensitiveValues: [memberId]
    })
    : undefined;
  const targetApp = await prepareTargetApp(options, 3101, tenant);
  const origin = targetApp.origin;
  const authProvider = authProviderFromOptions(options, tenant);

  try {
    const capability = await loadCapabilityForOptions(capabilityId, options, tenant);
    const summary = await replayCapability({
      capability,
      inputs: replayInputs(options, memberId),
      origin,
      scenario: options.scenario,
      headless: headlessFromOptions(options),
      evidence,
      approvalGranted: options.approvalGranted === "true",
      approvalHandler: interactiveApprovalHandler(options, replayInputs(options, memberId)),
      authProvider
    });

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await targetApp.close();
  }
}

async function runCompileDiscoveryCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const tenant = await tenantProfileFromOptions(options);
  const compileTarget = compileTargetFor(options);
  const targetApp = await prepareTargetApp(options, 3104, tenant);
  const origin = targetApp.origin;
  const goal = options.goal ?? compileTarget.goal;
  const outputPath = options.output ?? compileTarget.outputPath;

  const session = await createPlaywrightSession({
    headless: headlessFromOptions(options)
  });
  const authProvider = authProviderFromOptions(options, tenant);

  try {
    const policyCapability = await loadCapabilityForOptions(compileTarget.capabilityId, options, tenant);
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const model = new ScriptedDiscoveryModel(scriptedDecisionsForCompileTarget(compileTarget));
    await authProvider?.authenticate({
      origin,
      page: session.page,
      capability: policyCapability
    });
    const discovery = await runDiscovery({
      goal,
      entrypoint: `${origin}/servicing/search`,
      surface,
      model,
      policyCapability,
      maxSteps: Number(options.maxSteps ?? String(compileTarget.maxSteps)),
      timeoutMs: Number(options.timeoutMs ?? "120000")
    });
    const artifact = compileDiscoveryToArtifact({
      goal,
      run: discovery,
      capabilityId: compileTarget.capabilityId
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
    await targetApp.close();
  }
}

async function runHandoffCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const tenant = await tenantProfileFromOptions(options);
  const targetApp = await prepareTargetApp(options, 3105, tenant);
  const origin = targetApp.origin;
  const memberId = defaultMemberId(options, tenant);
  const evidence = options.evidencePath
    ? await createJsonlRecorder(options.evidencePath, {
      runId: `handoff-${Date.now()}`,
      capabilityId: "member.get-account-balances",
      sensitiveValues: [memberId]
    })
    : undefined;
  const session = await createPlaywrightSession({
    headless: headlessFromOptions(options)
  });
  const adapter = new PlaywrightSurfaceAdapter({
    page: session.page,
    sessionId: session.id,
    evidenceDir: "evidence/tmp/handoff"
  });
  const manager = new InterventionManager({
    sensitiveValues: [memberId]
  });
  let operator: Awaited<ReturnType<typeof createOperatorServer>> | undefined;

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
    await session.page.getByRole("link", { name: "Start New Session" }).evaluate((element) => {
      (element as HTMLElement).style.outline = "4px solid #f59e0b";
      (element as HTMLElement).style.outlineOffset = "3px";
      (element as HTMLElement).style.boxShadow = "0 0 0 6px rgba(245, 158, 11, .25)";
    }).catch(() => undefined);

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
    const ttlSeconds = Number(options.handoffTtlSeconds ?? "60");
    operator = await createOperatorServer(manager, {
      title: "LegacyBridge Human Handoff",
      instructions: "Review the captured session-expired screen, then click Confirm Resume at the top of this page.",
      showResume: true,
      sensitiveValues: [memberId],
      screenshotPath: intervention.screenshot?.path,
      highlightText: "Start New Session",
      ttlSeconds: options.interactive === "true" ? ttlSeconds : undefined
    });

    manager.takeHumanControl();
    await evidence?.record("control_transferred", {
      payload: {
        transition: manager.evidence().ownershipTransitions.at(-1)
      }
    });
    const blockedAutomationMessage = captureBlockedAutomation(manager);

    if (options.interactive === "true") {
      console.log(`Operator handoff URL: ${operator.url}`);
      console.log(`Waiting up to ${ttlSeconds}s for Confirm Resume. The countdown is shown in the browser.`);
      const resumeRequested = await operator.waitForResume(ttlSeconds * 1000);
      if (!resumeRequested) {
        manager.controlState.fail();
        console.log(JSON.stringify(redactStructuredValue({
          status: "handoff_timeout",
          operatorUrl: operator.url,
          waitedSeconds: ttlSeconds,
          evidence: manager.evidence()
        }, [memberId]), null, 2));
        return;
      }
      const humanAction = manager.recordHumanClick("Confirm Resume");
      await evidence?.record("human_action", {
        payload: {
          humanAction
        }
      });
    } else {
      const humanInput = manager.recordHumanInput("Operator reauthentication member hint", memberId);
      await evidence?.record("human_action", {
        payload: {
          humanAction: humanInput
        }
      });
      const humanClick = manager.recordHumanClick("Start New Session");
      await evidence?.record("human_action", {
        payload: {
          humanAction: humanClick
        }
      });
    }

    await session.page.getByRole("link", { name: "Start New Session" }).click();
    const humanNavigation = manager.recordHumanNavigation(`${origin}/servicing/search`);
    await evidence?.record("human_action", {
      payload: {
        humanAction: humanNavigation
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
    await operator?.close();
    await session.close();
    await targetApp.close();
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
  const tenant = await tenantProfileFromOptions(options);
  const capabilityId = positional[0] ?? options.capability ?? "member.get-account-balances";
  const runs = Number(options.runs ?? "5");
  const memberId = defaultMemberId(options, tenant);
  const targetApp = await prepareTargetApp(options, 3106, tenant);
  const origin = targetApp.origin;
  const authProvider = authProviderFromOptions(options, tenant);

  try {
    const capability = await loadCapabilityForOptions(capabilityId, options, tenant);
    const report = await validateCapabilityStability({
      capability,
      origin,
      runs,
      headless: headlessFromOptions(options),
      approvalGranted: options.approvalGranted === "true",
      authProvider,
      inputsForRun: () => ({
        ...replayInputs(options, memberId)
      })
    });
    const validatedCapability = {
      ...capability,
      validation: report.validation
    };
    const outputPath = options.output ?? defaultCapabilityPath(capabilityId, tenant);
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
    await targetApp.close();
  }
}

async function runCatalogCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const tenant = await tenantProfileFromOptions(options);
  const targetApp = await prepareTargetApp({
    ...options,
    port: options.demoPort ?? options.port
  }, 3107, tenant);
  const catalogPort = options.catalogPort ? Number(options.catalogPort) : undefined;
  const memberId = defaultMemberId(options, tenant);
  const origin = targetApp.origin;
  const authProvider = authProviderFromOptions(options, tenant);

  const loadedCapabilities = await loadCatalogCapabilities(options, tenant);
  const capabilities = options.approved === "false"
    ? loadedCapabilities
    : loadedCapabilities.map((capability) => withCapabilityStatus(capability, "approved"));
  const catalog = await createCapabilityCatalogServer({
    capabilities,
    replayOrigin: origin,
    authProvider,
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
    await targetApp.close();
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

async function tenantProfileFromOptions(options: Record<string, string>): Promise<TenantProfile | undefined> {
  const tenant = options.tenant ?? options.tenantProfile;
  return tenant ? loadTenantProfile(tenant) : undefined;
}

async function loadCapabilityForOptions(
  capabilityId: string,
  options: Record<string, string>,
  tenant: TenantProfile | undefined
): Promise<CapabilityArtifact> {
  if (options.capabilityPath) {
    return loadCapabilityArtifactFromPath(options.capabilityPath);
  }
  const tenantPath = capabilityPathForTenant(tenant, capabilityId);
  return tenantPath ? loadCapabilityArtifactFromPath(tenantPath) : loadCapabilityArtifact(capabilityId);
}

async function loadCatalogCapabilities(
  options: Record<string, string>,
  tenant: TenantProfile | undefined
): Promise<CapabilityArtifact[]> {
  if (options.capability || options.capabilityPath) {
    return [await loadCapabilityForOptions(options.capability ?? "member.get-account-balances", options, tenant)];
  }

  if (tenant) {
    const capabilityIds = Object.keys(tenant.capabilities);
    return Promise.all(capabilityIds.map((capabilityId) => loadCapabilityForOptions(capabilityId, options, tenant)));
  }

  return [await loadCapabilityArtifact("member.get-account-balances")];
}

function defaultCapabilityPath(capabilityId: string, tenant?: TenantProfile): string {
  const tenantPath = capabilityPathForTenant(tenant, capabilityId);
  if (tenantPath) {
    return tenantPath;
  }
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

type TargetApp = {
  origin: string;
  close(): Promise<void>;
};

type ManagedDemoServer = DemoAppServer | RiversideAppServer;

async function prepareTargetApp(options: Record<string, string>, defaultPort: number, tenant?: TenantProfile): Promise<TargetApp> {
  const configuredOrigin = options.origin ?? tenant?.application.defaultOrigin;
  if (options.origin && options.noDemoServer !== "false") {
    return {
      origin: stripTrailingSlash(options.origin),
      async close() {
        return undefined;
      }
    };
  }

  if (options.noDemoServer === "true") {
    return {
      origin: stripTrailingSlash(configuredOrigin ?? "http://127.0.0.1:3000"),
      async close() {
        return undefined;
      }
    };
  }

  const port = Number(options.port ?? String(defaultPort));
  const server = createCliDemoAppServer(options, tenant);
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    origin: stripTrailingSlash(configuredOrigin && options.noDemoServer === "true" ? configuredOrigin : `http://127.0.0.1:${port}`),
    async close() {
      await closeDemoServer(server);
    }
  };
}

async function closeDemoServer(server: ManagedDemoServer): Promise<void> {
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

function stripTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function headlessFromOptions(options: Record<string, string>): boolean {
  if (options.headed === "true") {
    return false;
  }
  return options.headless !== "false";
}

function interactiveApprovalHandler(
  options: Record<string, string>,
  inputs: Record<string, string>
): ((request: ReplayApprovalRequest) => Promise<ReplayApprovalDecision>) | undefined {
  if (options.interactive !== "true") {
    return undefined;
  }

  return async (request) => {
    const ttlSeconds = Number(options.approvalTtlSeconds ?? options.handoffTtlSeconds ?? "60");
    const sensitiveValues = Object.values(inputs);
    const manager = new InterventionManager({
      sensitiveValues
    });
    await highlightStepTarget(request);
    const intervention = await manager.trigger({
      runId: `approval-${Date.now()}`,
      capabilityId: request.capability.capability.id,
      currentStepId: request.step.id,
      reason: "RISK_APPROVAL_REQUIRED",
      currentRoute: request.page.url(),
      lastActionIds: request.capability.steps.map((step) => step.id),
      surface: request.adapter
    });
    await installApprovalTimerBanner(request, ttlSeconds);
    manager.takeHumanControl();
    const operator = await createOperatorServer(manager, {
      title: "LegacyBridge Approval Required",
      instructions: `${request.reason}. Review the captured application screen, then click Approve Action at the top of this page to continue replay.`,
      showApproval: true,
      showResume: false,
      sensitiveValues,
      screenshotPath: intervention.screenshot?.path,
      highlightText: targetHighlightText(request.step),
      ttlSeconds
    });

    try {
      console.log(`Approval URL: ${operator.url}`);
      console.log(`Waiting up to ${ttlSeconds}s for Approve Action or a human-completed confirmation in the browser.`);
      const decision = await waitForApprovalDecision(operator, request, ttlSeconds);
      if (!decision.approved) {
        manager.controlState.fail();
        console.log(JSON.stringify(redactStructuredValue({
          status: "approval_timeout",
          operatorUrl: operator.url,
          waitedSeconds: ttlSeconds,
          evidence: manager.evidence()
        }, sensitiveValues), null, 2));
        return decision;
      }

      manager.recordHumanClick(decision.completedByHuman ? targetHighlightText(request.step) : "Approve Action");
      manager.complete();
      console.log(decision.completedByHuman
        ? "Human completed the confirmation in the browser; continuing replay."
        : "Approval recorded; continuing replay.");
      return decision;
    } finally {
      await removeApprovalTimerBanner(request.page);
      await operator?.close();
    }
  };
}

async function waitForApprovalDecision(
  operator: Awaited<ReturnType<typeof createOperatorServer>>,
  request: ReplayApprovalRequest,
  ttlSeconds: number
): Promise<{ approved: boolean; completedByHuman: boolean }> {
  const timeoutMs = ttlSeconds * 1000;
  let settled = false;
  const operatorApproval = operator.waitForApproval(timeoutMs).then((approved) => {
    settled = true;
    return {
      approved,
      completedByHuman: false
    };
  });
  const humanCompletion = waitForHumanCompletedApprovalStep(request, timeoutMs, () => settled).then((completed) => {
    settled = true;
    return {
      approved: completed,
      completedByHuman: completed
    };
  });

  return Promise.race([operatorApproval, humanCompletion]);
}

async function waitForHumanCompletedApprovalStep(
  request: ReplayApprovalRequest,
  timeoutMs: number,
  shouldStop: () => boolean
): Promise<boolean> {
  const startedAt = Date.now();
  while (!shouldStop() && Date.now() - startedAt < timeoutMs) {
    if (await stepWaitSatisfiedNow(request)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return false;
}

async function stepWaitSatisfiedNow(request: ReplayApprovalRequest): Promise<boolean> {
  const wait = request.step.wait;
  if (!wait) {
    return false;
  }

  if (wait.type === "text") {
    for (const frame of request.page.frames()) {
      const text = await frame.locator("body").innerText().catch(() => "");
      if (text.includes(wait.text)) {
        return true;
      }
    }
    return false;
  }

  if (wait.type === "element") {
    const target = await request.adapter.locate(wait.target).catch(() => undefined);
    return (target?.matchCount === 1) === (wait.state === "visible");
  }

  return false;
}

async function installApprovalTimerBanner(request: ReplayApprovalRequest, ttlSeconds: number): Promise<void> {
  await request.page.evaluate(({ ttlSeconds: seconds, label }) => {
    const win = window as Window & { __legacyBridgeApprovalTimer?: number };
    if (win.__legacyBridgeApprovalTimer) {
      clearInterval(win.__legacyBridgeApprovalTimer);
    }
    document.getElementById("legacybridge-approval-banner")?.remove();
    const banner = document.createElement("div");
    banner.id = "legacybridge-approval-banner";
    banner.setAttribute("role", "status");
    banner.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "background:#12395a",
      "color:white",
      "font:15px Arial, Helvetica, sans-serif",
      "padding:10px 14px",
      "box-shadow:0 2px 12px rgba(0,0,0,.25)"
    ].join(";");
    banner.innerHTML = `LegacyBridge approval window: ${label} | Time left: <strong id="legacybridge-approval-countdown">${seconds}</strong>s`;
    document.body.prepend(banner);
    let remaining = seconds;
    win.__legacyBridgeApprovalTimer = window.setInterval(() => {
      remaining -= 1;
      const countdown = document.getElementById("legacybridge-approval-countdown");
      if (countdown) {
        countdown.textContent = String(Math.max(remaining, 0));
      }
      if (remaining <= 0 && win.__legacyBridgeApprovalTimer) {
        clearInterval(win.__legacyBridgeApprovalTimer);
        win.__legacyBridgeApprovalTimer = undefined;
      }
    }, 1000);
  }, {
    ttlSeconds,
    label: targetHighlightText(request.step)
  }).catch(() => undefined);
}

async function removeApprovalTimerBanner(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as Window & { __legacyBridgeApprovalTimer?: number };
    if (win.__legacyBridgeApprovalTimer) {
      clearInterval(win.__legacyBridgeApprovalTimer);
      win.__legacyBridgeApprovalTimer = undefined;
    }
    document.getElementById("legacybridge-approval-banner")?.remove();
  }).catch(() => undefined);
}

async function highlightStepTarget(request: ReplayApprovalRequest): Promise<void> {
  if (!request.step.target) {
    return;
  }

  const target = await request.adapter.locate(request.step.target).catch(() => undefined);
  const locator = (target as { locator?: { evaluate: (callback: (element: Element) => void) => Promise<void> } } | undefined)?.locator;
  await locator?.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.style.outline = "4px solid #f59e0b";
    htmlElement.style.outlineOffset = "3px";
    htmlElement.style.boxShadow = "0 0 0 6px rgba(245, 158, 11, .25)";
  }).catch(() => undefined);
}

function targetHighlightText(step: CapabilityArtifact["steps"][number]): string {
  const primary = step.target?.primary;
  if (primary?.strategy === "accessible") {
    return primary.name;
  }
  if (primary?.strategy === "text") {
    return primary.text;
  }
  return step.target?.description ?? step.id;
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

function defaultMemberId(options: Record<string, string>, tenant?: TenantProfile): string {
  return options.memberId ?? tenant?.demoDefaults?.memberId ?? "54321";
}

function authProviderFromOptions(options: Record<string, string>, tenant?: TenantProfile): RuntimeAuthProvider | undefined {
  if (options.auth === "none") {
    return undefined;
  }

  const auth = tenant?.auth;
  if (auth && auth.provider !== "demo-form") {
    throw new Error(`Unsupported auth provider for tenant ${tenant.tenantId}: ${auth.provider}`);
  }

  const username = options.runtimeUser ?? process.env.LEGACYBRIDGE_RUNTIME_USER ?? auth?.defaultRuntimeUser ?? "readwrite";
  const password = options.runtimePassword ?? process.env.LEGACYBRIDGE_RUNTIME_PASSWORD ?? auth?.defaultRuntimePassword ?? "rw123";
  return new DemoFormAuthProvider({
    username,
    password,
    loginPath: auth?.loginPath,
    usernameLabel: auth?.usernameLabel,
    passwordLabel: auth?.passwordLabel,
    submitLabel: auth?.submitLabel,
    postLoginPath: auth?.postLoginPath,
    roleByUsername: auth?.roleByUsername
  });
}

function createCliDemoAppServer(options: Record<string, string>, tenant?: TenantProfile): ManagedDemoServer {
  if (tenant?.application.appFamily === "riverside-member-console") {
    return createRiversideAppServer({
      authRequired: options.auth !== "none"
    });
  }

  return createDemoAppServer({
    persistState: options.ephemeralState !== "true",
    statePath: options.statePath,
    authRequired: options.auth !== "none"
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
  if (parsed.nodemoserver && !parsed.noDemoServer) {
    parsed.noDemoServer = parsed.nodemoserver;
  }
  return parsed;
}

type CompileTarget = {
  capabilityId: CompilableCapabilityId;
  goal: string;
  outputPath: string;
  maxSteps: number;
  memberId: string;
  accountNumber?: string;
  amount?: string;
};

function compileTargetFor(options: Record<string, string>): CompileTarget {
  const capabilityId = normalizeCompilableCapabilityId(options.capability);
  const memberId = options.memberId ?? "12345";
  const accountNumber = options.accountNumber ?? (capabilityId === "member.withdraw-from-account" ? "C-442910" : "S-100234");
  const amount = options.amount ?? (capabilityId === "member.withdraw-from-account" ? "10.00" : "25.00");
  const outputPath = options.output ?? generatedArtifactPathFor(capabilityId);

  if (capabilityId === "member.deposit-to-account") {
    return {
      capabilityId,
      memberId,
      accountNumber,
      amount,
      outputPath,
      maxSteps: 9,
      goal: `Look up member ${memberId}, deposit ${amount} into account ${accountNumber}, and return the new balance.`
    };
  }

  if (capabilityId === "member.withdraw-from-account") {
    return {
      capabilityId,
      memberId,
      accountNumber,
      amount,
      outputPath,
      maxSteps: 9,
      goal: `Look up member ${memberId}, withdraw ${amount} from account ${accountNumber}, and return the new balance.`
    };
  }

  if (capabilityId === "member.get-transaction-history") {
    return {
      capabilityId,
      memberId,
      accountNumber,
      outputPath,
      maxSteps: 6,
      goal: `Look up member ${memberId}, open transactions for account ${accountNumber}, and return the most recent ten transactions.`
    };
  }

  return {
    capabilityId,
    memberId,
    outputPath,
    maxSteps: 6,
    goal: `Look up member ${memberId} and return every available account balance.`
  };
}

function normalizeCompilableCapabilityId(value: string | undefined): CompilableCapabilityId {
  if (
    value === "member.deposit-to-account" ||
    value === "member.withdraw-from-account" ||
    value === "member.get-transaction-history" ||
    value === "member.get-account-balances"
  ) {
    return value;
  }
  if (value === undefined || value === "member.get-savings-balance") {
    return "member.get-account-balances";
  }
  throw new Error(`compile-discovery does not support capability ${value}`);
}

function generatedArtifactPathFor(capabilityId: CompilableCapabilityId): string {
  const fileNames: Record<CompilableCapabilityId, string> = {
    "member.get-account-balances": "member-get-account-balances.draft.yaml",
    "member.deposit-to-account": "member-deposit-to-account.draft.yaml",
    "member.withdraw-from-account": "member-withdraw-from-account.draft.yaml",
    "member.get-transaction-history": "member-get-transaction-history.draft.yaml"
  };
  return join("capabilities", "generated", fileNames[capabilityId]);
}

function scriptedDecisionsForCompileTarget(target: CompileTarget) {
  if (target.capabilityId === "member.deposit-to-account") {
    return scriptedDepositDecisions(target);
  }
  if (target.capabilityId === "member.withdraw-from-account") {
    return scriptedWithdrawalDecisions(target);
  }
  if (target.capabilityId === "member.get-transaction-history") {
    return scriptedTransactionHistoryDecisions(target);
  }
  return scriptedAccountBalanceLookupDecisions(target.memberId);
}

function scriptedAccountBalanceLookupDecisions(memberId = "12345") {
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
        value: memberId
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
        accountBalances: "Accounts"
      }
    }
  ];
}

function scriptedDepositDecisions(target: CompileTarget) {
  const accountNumber = target.accountNumber ?? "S-100234";
  const amount = target.amount ?? "25.00";
  return [
    ...scriptedMemberSearchDecisions(target.memberId),
    {
      type: "act" as const,
      reason: "The requested account row has a Deposit action.",
      action: {
        type: "click" as const,
        target: {
          description: "Deposit action in the requested account row",
          primary: {
            strategy: "structural" as const,
            description: "Accounts table row action for the requested account number",
            rowText: accountNumber,
            controlText: "Deposit"
          }
        }
      }
    },
    {
      type: "act" as const,
      reason: "The deposit amount field is visible.",
      action: {
        type: "fill" as const,
        target: {
          description: "Deposit amount input",
          primary: {
            strategy: "label" as const,
            text: "Amount"
          }
        },
        value: amount
      }
    },
    {
      type: "act" as const,
      reason: "Submit the amount for deposit review.",
      action: {
        type: "click" as const,
        target: {
          description: "Continue to deposit review",
          primary: {
            strategy: "relative" as const,
            anchorText: "Amount",
            direction: "below" as const,
            controlType: "submit button"
          }
        }
      }
    },
    {
      type: "act" as const,
      reason: "The final deposit confirmation button is visible and requires approval in replay.",
      action: {
        type: "click" as const,
        target: {
          description: "Confirm Deposit button",
          primary: {
            strategy: "accessible" as const,
            role: "button",
            name: "Confirm Deposit"
          }
        }
      }
    },
    {
      type: "act" as const,
      reason: "Extract the new balance from the confirmation page.",
      action: {
        type: "extract" as const,
        target: {
          description: "New balance from the deposit confirmation table",
          primary: {
            strategy: "structural" as const,
            description: "Confirmation table new balance value",
            rowText: "New Balance",
            columnText: "Value"
          }
        }
      }
    },
    {
      type: "goal_complete" as const,
      reason: "The deposit confirmation page was reached and the new balance was extracted.",
      outputs: {
        newBalance: "Deposit Confirmation"
      }
    }
  ];
}

function scriptedWithdrawalDecisions(target: CompileTarget) {
  const accountNumber = target.accountNumber ?? "C-442910";
  const amount = target.amount ?? "10.00";
  return [
    ...scriptedMemberSearchDecisions(target.memberId),
    {
      type: "act" as const,
      reason: "The requested account row has a Withdraw action.",
      action: {
        type: "click" as const,
        target: {
          description: "Withdraw action in the requested account row",
          primary: {
            strategy: "structural" as const,
            description: "Accounts table row action for the requested account number",
            rowText: accountNumber,
            controlText: "Withdraw"
          }
        }
      }
    },
    {
      type: "act" as const,
      reason: "The withdrawal amount field is visible.",
      action: {
        type: "fill" as const,
        target: {
          description: "Withdrawal amount input",
          primary: {
            strategy: "label" as const,
            text: "Amount"
          }
        },
        value: amount
      }
    },
    {
      type: "act" as const,
      reason: "Submit the amount for withdrawal review.",
      action: {
        type: "click" as const,
        target: {
          description: "Continue to withdrawal review",
          primary: {
            strategy: "relative" as const,
            anchorText: "Amount",
            direction: "below" as const,
            controlType: "submit button"
          }
        }
      }
    },
    {
      type: "act" as const,
      reason: "The final withdrawal confirmation button is visible and requires approval in replay.",
      action: {
        type: "click" as const,
        target: {
          description: "Confirm Withdrawal button",
          primary: {
            strategy: "accessible" as const,
            role: "button",
            name: "Confirm Withdrawal"
          }
        }
      }
    },
    {
      type: "act" as const,
      reason: "Extract the new balance from the confirmation page.",
      action: {
        type: "extract" as const,
        target: {
          description: "New balance from the withdrawal confirmation table",
          primary: {
            strategy: "structural" as const,
            description: "Confirmation table new balance value",
            rowText: "New Balance",
            columnText: "Value"
          }
        }
      }
    },
    {
      type: "goal_complete" as const,
      reason: "The withdrawal confirmation page was reached and the new balance was extracted.",
      outputs: {
        newBalance: "Withdrawal Confirmation"
      }
    }
  ];
}

function scriptedTransactionHistoryDecisions(target: CompileTarget) {
  const accountNumber = target.accountNumber ?? "S-100234";
  return [
    ...scriptedMemberSearchDecisions(target.memberId),
    {
      type: "act" as const,
      reason: "The requested account row has a Transactions action.",
      action: {
        type: "click" as const,
        target: {
          description: "Transactions action in the requested account row",
          primary: {
            strategy: "structural" as const,
            description: "Accounts table row action for the requested account number",
            rowText: accountNumber,
            controlText: "Transactions"
          }
        }
      }
    },
    {
      type: "act" as const,
      reason: "Extract the transactions table.",
      action: {
        type: "extract" as const,
        target: {
          description: "Most recent transactions table",
          primary: {
            strategy: "structural" as const,
            description: "Full transactions table containing Date/Time, Account Number, Account Type, Type, Amount, and Balance columns",
            columnText: "Balance"
          }
        }
      }
    },
    {
      type: "goal_complete" as const,
      reason: "The transaction history table was extracted.",
      outputs: {
        transactions: "Most Recent 10 Transactions"
      }
    }
  ];
}

function scriptedMemberSearchDecisions(memberId: string) {
  return scriptedAccountBalanceLookupDecisions(memberId).slice(0, 2);
}
