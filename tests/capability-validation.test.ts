import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact } from "../src/artifact/loader.js";
import { parseCapabilityArtifact } from "../src/artifact/schema.js";
import type { CapabilityArtifact } from "../src/artifact/types.js";
import { assertProductionInvokable, invokeProductionCapability } from "../src/catalog/production-catalog.js";
import { validateCapabilityStability } from "../src/catalog/validation.js";

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

function cloneAsStatus(capability: CapabilityArtifact, status: CapabilityArtifact["capability"]["status"]): CapabilityArtifact {
  return {
    ...structuredClone(capability),
    capability: {
      ...capability.capability,
      status
    }
  };
}

describe("capability validation and production approval gate", () => {
  it("rejects draft capabilities from the production catalog", async () => {
    const capability = await loadCapabilityArtifact("member.get-savings-balance");

    expect(() => assertProductionInvokable(capability)).toThrow("production catalog requires approved or active");
  });

  it("allows approved capabilities through the production catalog", async () => {
    const draft = await loadCapabilityArtifact("member.get-savings-balance");
    const approved = cloneAsStatus(draft, "approved");

    const result = await invokeProductionCapability({
      capability: approved,
      inputs: {
        memberId: "54321"
      },
      origin
    });

    expect(result.llmDecisionCalls).toBe(0);
    expect(result.result.status).toBe("success");
  }, 30_000);

  it("summarizes multi-run replay stability and produces a schema-valid validation block", async () => {
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
    const report = await validateCapabilityStability({
      capability,
      origin,
      runs: 3,
      inputsForRun: () => ({
        memberId: "54321"
      })
    });

    expect(report).toMatchObject({
      capabilityId: "member.get-savings-balance",
      version: "1.0.0",
      runs: 3,
      successes: 3,
      failures: 0,
      primaryLocatorUsage: 1,
      fallbackLocatorUsage: 0,
      status: "eligible-for-approval"
    });
    expect(() => parseCapabilityArtifact({
      ...capability,
      validation: report.validation
    })).not.toThrow();
  }, 30_000);
});
