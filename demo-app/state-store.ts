import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemberStore, type Member } from "./data.js";

export type MemberStore = Record<string, Member>;

export type DemoState = {
  members: MemberStore;
};

export const defaultStatePath = fileURLToPath(new URL("state.json", import.meta.url));

export function loadPersistentState(path = defaultStatePath): DemoState {
  if (!existsSync(path)) {
    const state = seededState();
    savePersistentState(state, path);
    return state;
  }

  return JSON.parse(readFileSync(path, "utf8")) as DemoState;
}

export function savePersistentState(state: DemoState, path = defaultStatePath): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function resetPersistentState(path = defaultStatePath): DemoState {
  const state = seededState();
  savePersistentState(state, path);
  return state;
}

export function seededState(): DemoState {
  return {
    members: createMemberStore()
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2] ?? "reset";
  if (command !== "reset") {
    throw new Error(`Unknown demo state command: ${command}`);
  }
  resetPersistentState(process.argv[3]);
  console.log(`Demo state reset at ${process.argv[3] ?? defaultStatePath}`);
}
