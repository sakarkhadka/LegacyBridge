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
  console.log("LegacyBridge CLI scaffold");
  console.log("Commands: discover, replay, handoff, validate-capability");
} else {
  console.log(`LegacyBridge command scaffold: ${command}`);
  console.log("Implementation pending. See status.md for current progress.");
}

