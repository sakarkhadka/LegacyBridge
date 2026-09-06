import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMemberStore, type AccountTransaction, type Member } from "./data.js";

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

  const state = normalizeState(JSON.parse(readFileSync(path, "utf8")) as DemoState);
  savePersistentState(state, path);
  return state;
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

function normalizeState(state: DemoState): DemoState {
  const seededAccounts = new Map(
    Object.values(createMemberStore())
      .flatMap((member) => member.accounts)
      .map((account) => [account.number, account])
  );

  for (const member of Object.values(state.members)) {
    for (const account of member.accounts) {
      account.history = normalizeHistory(account, seededAccounts.get(account.number)?.history);
    }
  }
  return state;
}

function normalizeHistory(
  account: Member["accounts"][number],
  seededHistory: AccountTransaction[] | undefined
): AccountTransaction[] {
  const history = Array.isArray(account.history) ? account.history : seededHistory;
  if (!Array.isArray(history)) {
    return [
      {
        datetime: "2026-09-06T00:00:00",
        accountNumber: account.number,
        accountType: account.type,
        type: "Deposit",
        amount: "+$0.00",
        balance: account.balance
      }
    ];
  }

  return history.map((transaction) => ({
    ...transaction,
    accountNumber: transaction.accountNumber ?? account.number,
    accountType: transaction.accountType ?? account.type
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2] ?? "reset";
  if (command !== "reset") {
    throw new Error(`Unknown demo state command: ${command}`);
  }
  resetPersistentState(process.argv[3]);
  console.log(`Demo state reset at ${process.argv[3] ?? defaultStatePath}`);
}
