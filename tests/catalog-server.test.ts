import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact } from "../src/artifact/loader.js";
import type { CapabilityArtifact } from "../src/artifact/types.js";
import { createCapabilityCatalogServer, type CapabilityCatalogServer } from "../src/catalog/catalog-server.js";

let demoServer: DemoAppServer;
let catalogServer: CapabilityCatalogServer;
let origin: string;

beforeEach(async () => {
  demoServer = createDemoAppServer();
  await new Promise<void>((resolve) => {
    demoServer.listen(0, "127.0.0.1", resolve);
  });
  const address = demoServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected demo app to listen on a TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await catalogServer?.close();
  catalogServer = undefined as unknown as CapabilityCatalogServer;
  await new Promise<void>((resolve, reject) => {
    demoServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

function withStatus(
  capability: CapabilityArtifact,
  status: CapabilityArtifact["capability"]["status"]
): CapabilityArtifact {
  return {
    ...structuredClone(capability),
    capability: {
      ...capability.capability,
      status
    }
  };
}

describe("agent-facing capability catalog", () => {
  it("returns public manifests without replay internals", async () => {
    const capability = withStatus(await loadCapabilityArtifact("member.get-account-balances"), "approved");
    catalogServer = await createCapabilityCatalogServer({
      capabilities: [capability],
      replayOrigin: origin
    });

    const response = await fetch(`${catalogServer.url}/capabilities`);
    const body = await response.json() as unknown;

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        name: "member.get-account-balances",
        description: "Retrieve every available account balance for a member.",
        inputs: {
          memberId: {
            type: "string",
            required: true,
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
        risk: "READ_ONLY"
      }
    ]);
    expect(JSON.stringify(body)).not.toContain("steps");
    expect(JSON.stringify(body)).not.toContain("Playwright");
    expect(JSON.stringify(body)).not.toContain("selector");
    expect(JSON.stringify(body)).not.toContain("iframe");
  });

  it("invokes an approved capability without requiring caller knowledge of UI details", async () => {
    const capability = withStatus(await loadCapabilityArtifact("member.get-account-balances"), "approved");
    catalogServer = await createCapabilityCatalogServer({
      capabilities: [capability],
      replayOrigin: origin
    });

    const response = await fetch(`${catalogServer.url}/capabilities/member.get-account-balances/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        memberId: "54321"
      })
    });
    const body = await response.json() as {
      result: {
        status: string;
        outputs?: Record<string, unknown>;
      };
      llmDecisionCalls: number;
    };

    expect(response.status).toBe(200);
    expect(body.llmDecisionCalls).toBe(0);
    expect(body.result.status).toBe("success");
    expect(body.result.outputs?.accountBalances).toEqual({
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

  it("blocks draft capability invocation through the catalog", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    catalogServer = await createCapabilityCatalogServer({
      capabilities: [capability],
      replayOrigin: origin
    });

    const response = await fetch(`${catalogServer.url}/capabilities/member.get-account-balances/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        memberId: "54321"
      })
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "CAPABILITY_NOT_APPROVED",
      status: "draft"
    });
  });
});
