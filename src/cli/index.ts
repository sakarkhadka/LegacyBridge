import { createDemoAppServer } from "../../demo-app/server.js";
import { loadCapabilityArtifact } from "../artifact/loader.js";
import { replayCapability } from "../replay/executor.js";

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
