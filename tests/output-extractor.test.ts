import { describe, expect, it } from "vitest";
import { parseOutput } from "../src/replay/output-extractor.js";

describe("output extraction", () => {
  it("parses Riverside-style account balance tables", () => {
    const output = parseOutput([
      "Product\tAccount\tAvailable Balance",
      "Everyday Share\tRS-240001\t$1,420.55",
      "Rainy Day Checking\tRC-240778\t$6,230.04"
    ].join("\n"), "accountBalances");

    expect(output).toEqual({
      type: "accountBalances",
      value: [
        {
          accountType: "Everyday Share",
          balance: {
            amount: 1420.55,
            currency: "USD"
          }
        },
        {
          accountType: "Rainy Day Checking",
          balance: {
            amount: 6230.04,
            currency: "USD"
          }
        }
      ]
    });
  });
});
