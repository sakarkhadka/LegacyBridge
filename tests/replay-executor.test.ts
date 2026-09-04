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
    const capability = await loadCapabilityArtifact("member.get-savings-balance");

    expect(capability.schemaVersion).toBe("1.0");
    expect(capability.capability.id).toBe("member.get-savings-balance");
    expect(capability.inputs.memberId?.sensitive).toBe(true);
    expect(capability.steps).toHaveLength(4);
  });

  it("replays the savings lookup for a different member without LLM decisions", async () => {
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
    expect(summary.result.outputs.balance).toEqual({
      type: "money",
      value: {
        amount: 8044.19,
        currency: "USD"
      }
    });
  });

  it("replays successfully when model credentials are unavailable", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const capability = await loadCapabilityArtifact("member.get-savings-balance");

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

  it("returns member not found as a business outcome instead of a failure", async () => {
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
    const capability = await loadCapabilityArtifact("member.get-savings-balance");
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
