import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact, saveCapabilityArtifact } from "../src/artifact/loader.js";
import { parseCapabilityArtifact } from "../src/artifact/schema.js";
import { compileDiscoveryToArtifact } from "../src/discovery/artifact-compiler.js";
import type { AgentDecision } from "../src/discovery/decision-schema.js";
import { runDiscovery } from "../src/discovery/agent.js";
import { ScriptedDiscoveryModel } from "../src/discovery/model.js";
import type { DiscoveryRunResult } from "../src/discovery/run-state.js";
import { replayCapability } from "../src/replay/executor.js";
import { PlaywrightSurfaceAdapter } from "../src/surface/playwright/playwright-adapter.js";
import { createPlaywrightSession, type PlaywrightSession } from "../src/surface/playwright/session.js";

let server: DemoAppServer;
let session: PlaywrightSession;
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

afterEach(async () => {
  await session?.close();
  session = undefined as unknown as PlaywrightSession;
});

describe("artifact compiler", () => {
  it("compiles successful discovery into a redacted draft artifact that replays without LLM decisions", async () => {
    const policyCapability = await loadCapabilityArtifact("member.get-account-balances");
    session = await createPlaywrightSession({ headless: true });
    const surface = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id
    });
    const goal = "Look up member 12345 and return every available account balance.";
    const discovery = await runDiscovery({
      goal,
      entrypoint: `${origin}/servicing/search`,
      surface,
      model: new ScriptedDiscoveryModel([
        {
          type: "act",
          reason: "Fill the member number.",
          action: {
            type: "fill",
            target: {
              description: "Member Number field",
              primary: {
                strategy: "label",
                text: "Member Number"
              },
              fallbacks: [
                {
                  strategy: "accessible",
                  role: "textbox",
                  name: "Member Number"
                }
              ]
            },
            value: "12345"
          }
        },
        {
          type: "act",
          reason: "Submit the member search form.",
          action: {
            type: "click",
            target: {
              description: "Search button in the member search form",
              primary: {
                strategy: "relative",
                anchorText: "Member Number",
                direction: "below",
                controlType: "submit button"
              },
              fallbacks: [
                {
                  strategy: "accessible",
                  role: "button",
                  name: "Search"
                }
              ]
            }
          }
        },
        {
          type: "act",
          reason: "Extract the accounts table.",
          action: {
            type: "extract",
            target: {
              description: "Accounts table with all available balances",
              primary: {
                strategy: "structural",
                description: "Full Accounts table containing account type, account number, and balance columns",
                columnText: "Balance"
              }
            }
          }
        },
        {
          type: "goal_complete",
          reason: "The account balances were extracted.",
          outputs: {
            accountBalances: "Account Type\tAccount Number\tBalance\tActions\nSavings\tS-100234\t$3,182.46\tDeposit Withdraw Transactions\nChecking\tC-442910\t$842.10\tDeposit Withdraw Transactions"
          }
        }
      ]),
      policyCapability,
      maxSteps: 6
    });

    expect(discovery.status).toBe("success");
    const artifact = compileDiscoveryToArtifact({
      goal,
      run: discovery
    });
    const outputPath = join("capabilities", "generated", "member-get-account-balances.draft.yaml");
    await saveCapabilityArtifact(outputPath, artifact);
    const yaml = await readFile(outputPath, "utf8");

    expect(yaml).not.toContain("12345");
    expect(yaml).not.toContain("S-100234");
    expect(yaml).not.toContain("C-442910");
    expect(artifact.capability.status).toBe("draft");
    expect(artifact.inputs.memberId).toBeDefined();
    expect(artifact.outputs.accountBalances).toBeDefined();
    expect(artifact.steps.length).toBeGreaterThanOrEqual(4);
    expect(artifact.steps.every((step) => step.action === "navigate" || step.target)).toBe(true);
    expect(artifact.checkpoint.conditions).toContainEqual({
      type: "output_present",
      output: "accountBalances"
    });
    expect(() => parseCapabilityArtifact(artifact)).not.toThrow();

    const replay = await replayCapability({
      capability: artifact,
      inputs: {
        memberId: "54321"
      },
      origin
    });

    expect(replay.llmDecisionCalls).toBe(0);
    expect(replay.result.status).toBe("success");
    if (replay.result.status !== "success") {
      throw new Error("Expected replay success");
    }
    expect(replay.result.outputs.accountBalances).toEqual({
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
  }, 30_000);

  it("generates replayable draft artifacts for deposit, withdrawal, and transaction history", async () => {
    const generatedDeposit = compileDiscoveryToArtifact({
      capabilityId: "member.deposit-to-account",
      goal: "Look up member 12345, deposit 25.00 into account S-100234, and return the new balance.",
      run: successfulDiscoveryRun(demoDepositDecisions())
    });
    const generatedWithdrawal = compileDiscoveryToArtifact({
      capabilityId: "member.withdraw-from-account",
      goal: "Look up member 12345, withdraw 10.00 from account C-442910, and return the new balance.",
      run: successfulDiscoveryRun(demoWithdrawalDecisions())
    });
    const generatedTransactions = compileDiscoveryToArtifact({
      capabilityId: "member.get-transaction-history",
      goal: "Look up member 12345, open transactions for account S-100234, and return the most recent ten transactions.",
      run: successfulDiscoveryRun(demoTransactionHistoryDecisions())
    });

    for (const artifact of [generatedDeposit, generatedWithdrawal, generatedTransactions]) {
      const yaml = JSON.stringify(artifact);
      expect(artifact.capability.status).toBe("draft");
      expect(yaml).not.toContain("12345");
      expect(yaml).not.toContain("S-100234");
      expect(yaml).not.toContain("C-442910");
      expect(() => parseCapabilityArtifact(artifact)).not.toThrow();
    }

    expect(generatedDeposit.inputs).toHaveProperty("accountNumber");
    expect(generatedDeposit.inputs).toHaveProperty("amount");
    expect(generatedDeposit.steps.find((step) => step.id === "confirm-deposit")?.risk).toBe("IRREVERSIBLE_WRITE");
    expect(generatedWithdrawal.steps.find((step) => step.id === "confirm-withdrawal")?.risk).toBe("IRREVERSIBLE_WRITE");
    expect(generatedTransactions.outputs.transactions?.type).toBe("transactionHistory");

    const depositReplay = await replayCapability({
      capability: generatedDeposit,
      inputs: {
        memberId: "54321",
        accountNumber: "S-889120",
        amount: "1.00"
      },
      origin,
      approvalGranted: true
    });
    expect(depositReplay.result.status).toBe("success");

    const withdrawalReplay = await replayCapability({
      capability: generatedWithdrawal,
      inputs: {
        memberId: "54321",
        accountNumber: "C-119004",
        amount: "1.00"
      },
      origin,
      approvalGranted: true
    });
    expect(withdrawalReplay.result.status).toBe("success");

    const transactionsReplay = await replayCapability({
      capability: generatedTransactions,
      inputs: {
        memberId: "54321",
        accountNumber: "S-889120"
      },
      origin
    });
    expect(transactionsReplay.result.status).toBe("success");
  }, 60_000);
});

function successfulDiscoveryRun(decisions: AgentDecision[]): DiscoveryRunResult {
  return {
    status: "success",
    stopReason: "goal_completed",
    outputs: {},
    stepsExecuted: decisions.length - 1,
    modelDecisionCalls: decisions.length,
    trace: decisions.map((decision, index) => ({
      type: "model_decision" as const,
      stepNumber: index + 1,
      decision
    }))
  };
}

function memberSearchDecisions(): AgentDecision[] {
  return [
    {
      type: "act",
      reason: "Fill the member number.",
      action: {
        type: "fill",
        target: {
          description: "Member Number field",
          primary: {
            strategy: "label",
            text: "Member Number"
          }
        },
        value: "12345"
      }
    },
    {
      type: "act",
      reason: "Submit the search form.",
      action: {
        type: "click",
        target: {
          description: "Search button in the member search form",
          primary: {
            strategy: "relative",
            anchorText: "Member Number",
            direction: "below",
            controlType: "submit button"
          }
        }
      }
    }
  ];
}

function demoDepositDecisions(): AgentDecision[] {
  return [
    ...memberSearchDecisions(),
    rowActionDecision("Deposit action in the requested account row", "S-100234", "Deposit"),
    amountDecision("Deposit amount input", "25.00"),
    reviewDecision("Continue to deposit review"),
    buttonDecision("Confirm Deposit button", "Confirm Deposit"),
    extractNewBalanceDecision("New balance from the deposit confirmation table"),
    goalComplete("newBalance", "Deposit Confirmation")
  ];
}

function demoWithdrawalDecisions(): AgentDecision[] {
  return [
    ...memberSearchDecisions(),
    rowActionDecision("Withdraw action in the requested account row", "C-442910", "Withdraw"),
    amountDecision("Withdrawal amount input", "10.00"),
    reviewDecision("Continue to withdrawal review"),
    buttonDecision("Confirm Withdrawal button", "Confirm Withdrawal"),
    extractNewBalanceDecision("New balance from the withdrawal confirmation table"),
    goalComplete("newBalance", "Withdrawal Confirmation")
  ];
}

function demoTransactionHistoryDecisions(): AgentDecision[] {
  return [
    ...memberSearchDecisions(),
    rowActionDecision("Transactions action in the requested account row", "S-100234", "Transactions"),
    {
      type: "act",
      reason: "Extract the transaction history table.",
      action: {
        type: "extract",
        target: {
          description: "Most recent transactions table",
          primary: {
            strategy: "structural",
            description: "Full transactions table containing Date/Time, Account Number, Account Type, Type, Amount, and Balance columns",
            columnText: "Balance"
          }
        }
      }
    },
    goalComplete("transactions", "Most Recent 10 Transactions")
  ];
}

function rowActionDecision(description: string, accountNumber: string, controlText: string): AgentDecision {
  return {
    type: "act",
    reason: `Open ${controlText}.`,
    action: {
      type: "click",
      target: {
        description,
        primary: {
          strategy: "structural",
          description: "Accounts table row action for the requested account number",
          rowText: accountNumber,
          controlText
        }
      }
    }
  };
}

function amountDecision(description: string, amount: string): AgentDecision {
  return {
    type: "act",
    reason: "Enter the transaction amount.",
    action: {
      type: "fill",
      target: {
        description,
        primary: {
          strategy: "label",
          text: "Amount"
        }
      },
      value: amount
    }
  };
}

function reviewDecision(description: string): AgentDecision {
  return {
    type: "act",
    reason: "Continue to review.",
    action: {
      type: "click",
      target: {
        description,
        primary: {
          strategy: "relative",
          anchorText: "Amount",
          direction: "below",
          controlType: "submit button"
        }
      }
    }
  };
}

function buttonDecision(description: string, name: string): AgentDecision {
  return {
    type: "act",
    reason: `Click ${name}.`,
    action: {
      type: "click",
      target: {
        description,
        primary: {
          strategy: "accessible",
          role: "button",
          name
        }
      }
    }
  };
}

function extractNewBalanceDecision(description: string): AgentDecision {
  return {
    type: "act",
    reason: "Extract the new balance.",
    action: {
      type: "extract",
      target: {
        description,
        primary: {
          strategy: "structural",
          description: "Confirmation table new balance value",
          rowText: "New Balance",
          columnText: "Value"
        }
      }
    }
  };
}

function goalComplete(name: string, output: string): AgentDecision {
  return {
    type: "goal_complete",
    reason: "The requested output is available.",
    outputs: {
      [name]: output
    }
  };
}
