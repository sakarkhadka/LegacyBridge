import { createDemoAppServer } from "../../demo-app/server.js";
import { loadCapabilityArtifact } from "../artifact/loader.js";
import { runDiscovery } from "../discovery/agent.js";
import { OpenAIDiscoveryModel, ScriptedDiscoveryModel } from "../discovery/model.js";
import { redactStructuredValue } from "../policy/redaction.js";
import { replayCapability } from "../replay/executor.js";
import { PlaywrightSurfaceAdapter } from "../surface/playwright/playwright-adapter.js";
import { createPlaywrightSession } from "../surface/playwright/session.js";

const command = process.argv[2] ?? "help";

const knownCommands = new Set([
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
} else {
  console.log(`LegacyBridge command scaffold: ${command}`);
  console.log("Implementation pending. See status.md for current progress.");
}

function printHelp(): void {
  console.log("LegacyBridge CLI");
  console.log("Commands: discover, replay, handoff, validate-capability");
  console.log("");
  console.log("Replay example:");
  console.log("  npm run replay -- --capability member.get-savings-balance --memberId 54321");
  console.log("");
  console.log("Discovery example:");
  console.log("  npm run demo:discover -- --scripted");
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
    const capability = await loadCapabilityArtifact(capabilityId);
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
