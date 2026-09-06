import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact } from "../src/artifact/loader.js";
import { replayCapability } from "../src/replay/executor.js";

let server: DemoAppServer;
let origin: string;

beforeAll(async () => {
  server = createDemoAppServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected demo app to listen on a TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}, 30_000);

describe("deterministic replay executor", () => {
  it("loads the hand-authored replay capability through the artifact schema", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");

    expect(capability.schemaVersion).toBe("1.0");
    expect(capability.capability.id).toBe("member.get-account-balances");
    expect(capability.inputs.memberId?.sensitive).toBe(true);
    expect(capability.steps).toHaveLength(4);
  });

  it("replays the account balances lookup for a different member without LLM decisions", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("success");
    if (summary.result.status !== "success") {
      throw new Error("Expected replay success");
    }
    expect(summary.result.outputs.accountBalances).toEqual({
      type: "accountBalances",
      value: [
        {
          accountType: "Savings",
          balance: {
            amount: 8044.19,
            currency: "USD"
          }
        },
        {
          accountType: "Checking",
          balance: {
            amount: 12000,
            currency: "USD"
          }
        }
      ]
    });
  });

  it("replays successfully when model credentials are unavailable", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const capability = await loadCapabilityArtifact("member.get-account-balances");

    try {
      const summary = await replayCapability({
        capability,
        inputs: {
          memberId: "54321"
        },
        origin
      });

      expect(summary.llmDecisionCalls).toBe(0);
      expect(summary.result.status).toBe("success");
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  it("requires approval before confirming a deposit", async () => {
    const capability = await loadCapabilityArtifact("member.deposit-to-account");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "12345",
        accountNumber: "S-100234",
        amount: "25.00"
      },
      origin
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("failure");
    if (summary.result.status !== "failure") {
      throw new Error("Expected replay failure");
    }
    expect(summary.result.error.class).toBe("POLICY_VIOLATION");
    expect(summary.result.error.stepId).toBe("confirm-deposit");
    expect(summary.result.error.observed).toContain("irreversible write requires human approval");
  }, 30_000);

  it("deposits funds when approval is granted", async () => {
    const capability = await loadCapabilityArtifact("member.deposit-to-account");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "12345",
        accountNumber: "S-100234",
        amount: "25.00"
      },
      origin,
      approvalGranted: true
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("success");
    if (summary.result.status !== "success") {
      throw new Error("Expected replay success");
    }
    expect(summary.result.outputs.newBalance).toEqual({
      type: "money",
      value: {
        amount: 3207.46,
        currency: "USD"
      }
    });
  }, 30_000);

  it("withdraws funds when approval is granted", async () => {
    const capability = await loadCapabilityArtifact("member.withdraw-from-account");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "12345",
        accountNumber: "C-442910",
        amount: "42.10"
      },
      origin,
      approvalGranted: true
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("success");
    if (summary.result.status !== "success") {
      throw new Error("Expected replay success");
    }
    expect(summary.result.outputs.newBalance).toEqual({
      type: "money",
      value: {
        amount: 800,
        currency: "USD"
      }
    });
  }, 30_000);

  it("returns insufficient funds as a business outcome before withdrawal confirmation", async () => {
    const capability = await loadCapabilityArtifact("member.withdraw-from-account");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "12345",
        accountNumber: "C-442910",
        amount: "999999.00"
      },
      origin,
      approvalGranted: true
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result).toEqual({
      status: "business_outcome",
      outcome: {
        code: "INSUFFICIENT_FUNDS",
        description: "The requested withdrawal exceeds the account balance."
      }
    });
  }, 30_000);

  it("returns the ten most recent account transactions", async () => {
    const capability = await loadCapabilityArtifact("member.get-transaction-history");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "12345",
        accountNumber: "S-100234"
      },
      origin
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("success");
    if (summary.result.status !== "success") {
      throw new Error("Expected replay success");
    }
    expect(summary.result.outputs.transactions).toEqual({
      type: "transactionHistory",
      value: expect.arrayContaining([
        {
          datetime: "2026-09-05T14:18:00",
          accountNumber: "S-100234",
          accountType: "Savings",
          type: "Deposit",
          amount: {
            amount: 125,
            currency: "USD"
          },
          balance: {
            amount: 3182.46,
            currency: "USD"
          }
        }
      ])
    });
  }, 30_000);

  it("returns member not found as a business outcome instead of a failure", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "00000"
      },
      origin
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result).toEqual({
      status: "business_outcome",
      outcome: {
        code: "MEMBER_NOT_FOUND",
        description: "No member exists for the supplied member number."
      }
    });
  });

  it("recovers from a known interstitial and then succeeds", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin,
      scenario: "interstitial"
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("success");
    expect(summary.recoveries).toContainEqual({
      stepId: "navigate-to-search",
      condition: "KNOWN_INTERSTITIAL",
      action: "dismissed System Notice",
      recovered: true
    });
  });

  it("records transient slow-load recovery metadata and succeeds", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin,
      scenario: "slow"
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("success");
    expect(summary.recoveries.some((event) => event.condition === "TRANSIENT_LOAD" && event.recovered)).toBe(true);
  });

  it("classifies permission denied as a hard failure", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "88888"
      },
      origin
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("failure");
    if (summary.result.status !== "failure") {
      throw new Error("Expected replay failure");
    }
    expect(summary.result.error.class).toBe("PERMISSION_DENIED");
    expect(summary.result.error.recoverable).toBe(false);
  });

  it("classifies session expiration as a hard failure", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin,
      scenario: "session-expired"
    });

    expect(summary.result.status).toBe("failure");
    if (summary.result.status !== "failure") {
      throw new Error("Expected replay failure");
    }
    expect(summary.result.error.class).toBe("SESSION_EXPIRED");
  });

  it("classifies application error as a hard failure", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin,
      scenario: "error"
    });

    expect(summary.result.status).toBe("failure");
    if (summary.result.status !== "failure") {
      throw new Error("Expected replay failure");
    }
    expect(summary.result.error.class).toBe("APPLICATION_ERROR");
  });

  it("fails before browser execution when invocation inputs are invalid", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "abc"
      },
      origin
    });

    expect(summary.llmDecisionCalls).toBe(0);
    expect(summary.result.status).toBe("failure");
    if (summary.result.status !== "failure") {
      throw new Error("Expected replay failure");
    }
    expect(summary.result.error.class).toBe("PRECONDITION_FAILED");
  });
});
