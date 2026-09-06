import type { AccountBalanceValue, ValueType } from "../artifact/types.js";
import type { TypedOutput } from "./results.js";

export function parseOutput(raw: string, type: ValueType): TypedOutput {
  switch (type) {
    case "money":
      return {
        type,
        value: parseMoney(raw)
      };
    case "accountBalances":
      return {
        type,
        value: parseAccountBalances(raw)
      };
    case "number":
      return {
        type,
        value: Number(raw.replaceAll(",", ""))
      };
    case "boolean":
      return {
        type,
        value: raw.trim().toLowerCase() === "true"
      };
    case "string":
    case "enum":
      return {
        type,
        value: raw.trim()
      };
  }
}

function parseAccountBalances(raw: string): AccountBalanceValue[] {
  const rows = raw
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
  const dataRows = rows.filter((row) => !/^Account Type\s+/i.test(row));
  const balances = dataRows.map((row) => {
    const columns = row.split(/\t+/).map((column) => column.trim()).filter(Boolean);
    if (columns.length < 3) {
      throw new Error(`Unable to parse account balance row: ${row}`);
    }

    return {
      accountType: columns[0] ?? "",
      balance: parseMoney(columns[2] ?? "")
    };
  });

  if (balances.length === 0) {
    throw new Error(`Unable to parse account balances output: ${raw}`);
  }

  return balances;
}

function parseMoney(raw: string): { amount: number; currency: string } {
  const normalized = raw.trim();
  const match = normalized.match(/^\$?(-?[0-9,]+(?:\.[0-9]{2})?)$/);
  if (!match) {
    throw new Error(`Unable to parse money output: ${raw}`);
  }

  return {
    amount: Number(match[1]?.replaceAll(",", "")),
    currency: "USD"
  };
}
