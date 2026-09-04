import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact } from "../src/artifact/loader.js";
import type { CapabilityArtifact } from "../src/artifact/types.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { redactLogEvent } from "../src/policy/redaction.js";
import { replayCapability } from "../src/replay/executor.js";

let server: DemoAppServer;
let origin: string;

function cloneCapability(capability: CapabilityArtifact): CapabilityArtifact {
  return structuredClone(capability);
}

describe("policy engine and redaction", () => {
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

  it("blocks navigation to an external origin before surface execution", async () => {
    const capability = cloneCapability(await loadCapabilityArtifact("member.get-savings-balance"));
    capability.steps[0] = {
      ...capability.steps[0]!,
      value: {
        literal: "https://example.com/servicing/search"
      }
    };

    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin
    });

    expect(summary.result.status).toBe("failure");
    if (summary.result.status !== "failure") {
      throw new Error("Expected replay failure");
    }
    expect(summary.result.error.class).toBe("POLICY_VIOLATION");
    expect(summary.result.error.observed).toContain("origin https://example.com is not allowlisted");
  });

  it("blocks a non-allowlisted action before surface execution", async () => {
    const capability = cloneCapability(await loadCapabilityArtifact("member.get-savings-balance"));
    capability.policy.allowedActions = capability.policy.allowedActions.filter((action) => action !== "fill");

    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin
    });

    expect(summary.result.status).toBe("failure");
    if (summary.result.status !== "failure") {
      throw new Error("Expected replay failure");
    }
    expect(summary.result.error.class).toBe("POLICY_VIOLATION");
    expect(summary.result.error.stepId).toBe("enter-member-id");
    expect(summary.result.error.observed).toContain("action fill is not allowlisted");
  });

  it("requires human approval for irreversible actions", () => {
    const engine = new PolicyEngine({
      allowedOrigins: ["http://localhost:3000"],
      allowedRoutes: ["/servicing/*"],
      allowedActions: ["click"],
      irreversibleActionsRequireHuman: true
    });

    const decision = engine.check({
      origin: "http://localhost:3000",
      route: "/servicing/member/12345/sub-account-confirmed",
      action: "click",
      risk: "IRREVERSIBLE_WRITE"
    });

    expect(decision).toEqual({
      status: "requires_human_approval",
      reason: "irreversible write requires human approval"
    });
  });

  it("redacts sensitive parameter values from structured logs", () => {
    const event = redactLogEvent(
      {
        event: "run_failed",
        route: "/servicing/member/54321",
        message: "Permission denied for member 54321",
        nested: {
          observed: "Member 54321 is restricted"
        }
      },
      ["54321"]
    );

    expect(JSON.stringify(event)).not.toContain("54321");
    expect(event.route).toBe("/servicing/member/[REDACTED]");
  });

  it("redacts sensitive invocation values from replay failure details", async () => {
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "88888"
      },
      origin
    });

    expect(summary.result.status).toBe("failure");
    expect(JSON.stringify(summary.result)).not.toContain("88888");
    expect(JSON.stringify(summary.result)).toContain("[REDACTED]");
  });

  it("does not serialize actual invocation member IDs into the capability artifact", async () => {
    const artifact = await readFile("capabilities/member-get-savings-balance.v1.yaml", "utf8");

    expect(artifact).toContain("parameter: memberId");
    expect(artifact).not.toContain("12345");
    expect(artifact).not.toContain("54321");
    expect(artifact).not.toContain("88888");
  });
});
