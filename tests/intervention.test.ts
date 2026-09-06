import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import { createOperatorServer } from "../src/intervention/operator-server.js";
import { InterventionManager } from "../src/intervention/intervention-manager.js";
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

describe("human intervention handoff", () => {
  it("pauses automation, records human actions, verifies resume, and retains the same browser session", async () => {
    session = await createPlaywrightSession({ headless: true });
    const adapter = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id,
      evidenceDir: "evidence/tmp/tests-handoff"
    });
    const manager = new InterventionManager({
      sensitiveValues: ["54321"]
    });

    await adapter.act({
      type: "navigate",
      value: `${origin}/servicing/search?scenario=session-expired`
    });
    const intervention = await manager.trigger({
      runId: "test-run",
      capabilityId: "member.get-account-balances",
      currentStepId: "navigate-to-search",
      reason: "SESSION_EXPIRED",
      currentRoute: session.page.url(),
      lastActionIds: ["navigate-to-search"],
      surface: adapter
    });
    const operator = await createOperatorServer(manager);

    try {
      expect(intervention.reason).toBe("SESSION_EXPIRED");
      expect(intervention.screenshot?.kind).toBe("screenshot");
      expect(manager.controlState.currentState()).toBe("WAITING_FOR_HUMAN");

      manager.takeHumanControl();
      expect(manager.controlState.currentOwner()).toBe("human");
      expect(() => manager.assertAutomationMayAct()).toThrow("Automation cannot act");

      manager.recordHumanInput("Reauthentication member hint", "54321");
      manager.recordHumanClick("Start New Session");
      await session.page.getByRole("link", { name: "Start New Session" }).click();
      manager.recordHumanNavigation(`${origin}/servicing/search?member=54321`);
      manager.requestResume();

      const resume = await manager.verifyResume([
        {
          type: "text_present",
          value: "Member Search"
        }
      ], {
        page: session.page,
        adapter,
        outputs: {}
      });

      expect(resume).toEqual({
        ok: true,
        state: "RUNNING_AUTOMATION"
      });
      expect(adapter.getSession().id).toBe(session.id);
      expect(() => manager.assertAutomationMayAct()).not.toThrow();
      manager.complete();
      expect(manager.evidence().ownershipTransitions.map((transition) => transition.to)).toEqual(["human", "automation"]);
      expect(JSON.stringify(manager.evidence().humanActions)).not.toContain("54321");

      const status = await fetch(`${operator.url}/status`).then((response) => response.json() as Promise<{
        owner: string;
        status: string;
      }>);
      expect(status.owner).toBe("automation");
      expect(status.status).toBe("COMPLETED");
    } finally {
      await operator.close();
    }
  }, 30_000);
});
