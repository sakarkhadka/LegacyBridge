import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { loadCapabilityArtifact } from "../src/artifact/loader.js";
import { EvidenceRecorder, MemoryEvidenceSink } from "../src/evidence/recorder.js";
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

describe("evidence recorder", () => {
  it("redacts sensitive values before storing JSONL-style events", async () => {
    const sink = new MemoryEvidenceSink();
    const recorder = new EvidenceRecorder({
      runId: "test-run",
      capabilityId: "member.get-account-balances",
      sensitiveValues: ["54321"],
      sink
    });

    await recorder.record("run_failed", {
      payload: {
        route: "/servicing/member/54321",
        observed: "Permission denied for member 54321"
      }
    });

    expect(JSON.stringify(sink.events)).not.toContain("54321");
    expect(JSON.stringify(sink.events)).toContain("[REDACTED]");
  });

  it("records replay policy, target, action, checkpoint, and zero-LLM evidence", async () => {
    const capability = await loadCapabilityArtifact("member.get-account-balances");
    const sink = new MemoryEvidenceSink();
    const recorder = new EvidenceRecorder({
      runId: "replay-evidence-test",
      capabilityId: capability.capability.id,
      sensitiveValues: ["54321"],
      sink
    });

    const summary = await replayCapability({
      capability,
      inputs: {
        memberId: "54321"
      },
      origin,
      evidence: recorder
    });

    expect(summary.result.status).toBe("success");
    expect(summary.llmDecisionCalls).toBe(0);
    expect(sink.events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "run_started",
      "step_started",
      "policy_checked",
      "target_resolved",
      "action_completed",
      "checkpoint_passed",
      "run_completed"
    ]));
    expect(JSON.stringify(sink.events)).toContain("\"llmDecisionCalls\":0");
    expect(JSON.stringify(sink.events)).toContain("\"strategyUsed\"");
    expect(JSON.stringify(sink.events)).not.toContain("54321");
  }, 30_000);
});
