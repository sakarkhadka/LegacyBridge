import { describe, expect, it } from "vitest";
import { capabilityArtifactSchema, parseCapabilityArtifact } from "../src/artifact/schema.js";
import type { CapabilityArtifactInput } from "../src/artifact/schema.js";
import type { ExecutionResult } from "../src/replay/results.js";

function validArtifact(): CapabilityArtifactInput {
  return {
    schemaVersion: "1.0",
    capability: {
      id: "member.get-account-balances",
      version: "1.0.0",
      name: "Get account balances",
      description: "Look up a fictional member and return every available account balance.",
      status: "draft"
    },
    targetApplication: {
      vendor: "heritage-core",
      application: "Heritage Core Servicing",
      supportedVersions: ["demo"],
      fingerprint: {
        titlePatterns: ["Heritage Core"],
        routePatterns: ["/servicing/*"],
        landmarks: ["Member Search", "Accounts"]
      }
    },
    inputs: {
      memberId: {
        type: "string",
        required: true,
        sensitive: true,
        description: "Synthetic member number.",
        pattern: "^[0-9]{5}$"
      }
    },
    outputs: {
      accountBalances: {
        type: "accountBalances",
        required: true,
        description: "Available account balances for the member."
      }
    },
    outcomes: [
      {
        code: "MEMBER_NOT_FOUND",
        description: "No member exists for the supplied member number.",
        when: [
          {
            type: "text_present",
            value: "Member not found"
          }
        ]
      }
    ],
    steps: [
      {
        id: "navigate-to-search",
        action: "navigate",
        value: {
          literal: "http://localhost:3000/servicing/search"
        },
        wait: {
          type: "navigation"
        },
        postcondition: [
          {
            type: "text_present",
            value: "Member Search"
          }
        ]
      },
      {
        id: "enter-member-id",
        action: "fill",
        target: {
          description: "Member Number input",
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
        value: {
          parameter: "memberId"
        }
      },
      {
        id: "search-member",
        action: "click",
        target: {
          description: "Search button",
          primary: {
            strategy: "accessible",
            role: "button",
            name: "Search"
          }
        },
        wait: {
          type: "text",
          text: "Accounts"
        }
      },
      {
        id: "extract-account-balances",
        action: "extract",
        target: {
          description: "Accounts table with all available balances",
          primary: {
            strategy: "structural",
            description: "Full Accounts table containing account type, account number, and balance columns",
            columnText: "Balance"
          }
        },
        output: {
          name: "accountBalances",
          parseAs: "accountBalances"
        }
      }
    ],
    checkpoint: {
      description: "Account balances were extracted from the member account table.",
      conditions: [
        {
          type: "output_present",
          output: "accountBalances"
        }
      ]
    },
    policy: {
      allowedOrigins: ["http://localhost:3000"],
      allowedRoutes: ["/servicing/*"],
      allowedActions: ["navigate", "click", "fill", "select", "extract", "wait"],
      risk: "READ_ONLY"
    }
  };
}

describe("capability artifact schema", () => {
  it("accepts a valid artifact", () => {
    const parsed = parseCapabilityArtifact(validArtifact());

    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.capability.version).toBe("1.0.0");
    expect(parsed.inputs.memberId?.type).toBe("string");
    expect(parsed.outputs.accountBalances?.type).toBe("accountBalances");
    expect(parsed.steps[1]?.target?.primary.strategy).toBe("label");
  });

  it("rejects a missing capability version", () => {
    const artifact = validArtifact();
    delete (artifact.capability as Partial<typeof artifact.capability>).version;

    expect(capabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects a step that references an unknown input parameter", () => {
    const artifact = validArtifact();
    artifact.steps[1] = {
      ...artifact.steps[1],
      value: {
        parameter: "missingMemberId"
      }
    };

    const result = capabilityArtifactSchema.safeParse(artifact);

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected artifact validation to fail");
    }
    expect(JSON.stringify(result.error.issues)).toContain("unknown input parameter");
  });

  it("rejects an unknown output type", () => {
    const artifact = validArtifact();
    artifact.outputs.accountBalances = {
      type: "date",
      required: true
    } as never;

    expect(capabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects an invalid checkpoint", () => {
    const artifact = validArtifact();
    artifact.checkpoint.conditions = [] as never;

    expect(capabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects Playwright selector leakage in target strategies", () => {
    const artifact = validArtifact();
    artifact.steps[1] = {
      ...artifact.steps[1],
      target: {
        primary: {
          strategy: "css",
          selector: "#member-number"
        }
      }
    } as never;

    expect(capabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("keeps business outcomes separate from execution failures", () => {
    const businessOutcome: ExecutionResult = {
      status: "business_outcome",
      outcome: {
        code: "MEMBER_NOT_FOUND"
      }
    };

    const failure: ExecutionResult = {
      status: "failure",
      error: {
        class: "TARGET_NOT_FOUND",
        stepId: "enter-member-id",
        expected: "Member Number field",
        observed: "Search form without member field",
        recoverable: false
      }
    };

    expect(businessOutcome.status).toBe("business_outcome");
    expect(failure.status).toBe("failure");
  });
});
