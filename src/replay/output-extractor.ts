import type { ValueType } from "../artifact/types.js";
import type { TypedOutput } from "./results.js";

export function parseOutput(raw: string, type: ValueType): TypedOutput {
  switch (type) {
    case "money":
      return {
        type,
        value: parseMoney(raw)
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

