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

  it("serves an interactive operator page with approval and resume actions", async () => {
    session = await createPlaywrightSession({ headless: true });
    const adapter = new PlaywrightSurfaceAdapter({
      page: session.page,
      sessionId: session.id,
      evidenceDir: "evidence/tmp/tests-operator"
    });
    await adapter.act({
      type: "navigate",
      value: `${origin}/servicing/member/12345/account-transaction-review?operation=deposit&accountNumber=S-100234&amount=25.00`
    });
    const manager = new InterventionManager({
      sensitiveValues: ["12345"]
    });
    const intervention = await manager.trigger({
      runId: "approval-run",
      capabilityId: "member.deposit-to-account",
      currentStepId: "confirm-deposit",
      reason: "RISK_APPROVAL_REQUIRED",
      currentRoute: `${origin}/servicing/member/12345/account-transaction-review`,
      lastActionIds: ["confirm-deposit"],
      surface: adapter
    });
    manager.takeHumanControl();
    const operator = await createOperatorServer(manager, {
      title: "Test Operator Console",
      showApproval: true,
      showResume: true,
      sensitiveValues: ["12345"],
      screenshotPath: intervention.screenshot?.path,
      highlightText: "Confirm Deposit",
      ttlSeconds: 60
    });

    try {
      const html = await fetch(operator.url, {
        headers: {
          Accept: "text/html"
        }
      }).then((response) => response.text());
      expect(html).toContain("Approve Action");
      expect(html).toContain("Confirm Resume");
      expect(html).toContain("Time left");
      expect(html).toContain("Confirm Deposit");
      expect(html).toContain("/screenshot");
      expect(html).toContain("Close");
      expect(html).not.toContain("12345");

      const screenshot = await fetch(`${operator.url}/screenshot`);
      expect(screenshot.status).toBe(200);
      expect(screenshot.headers.get("content-type")).toBe("image/png");

      const approval = operator.waitForApproval(5000);
      const resume = operator.waitForResume(5000);
      await fetch(`${operator.url}/approve`, { method: "POST" });
      await fetch(`${operator.url}/resume`, { method: "POST" });

      expect(await approval).toBe(true);
      expect(await resume).toBe(true);
      const status = await fetch(`${operator.url}/status`).then((response) => response.json() as Promise<{
        approvalGranted: boolean;
        resumeRequested: boolean;
      }>);
      expect(status.approvalGranted).toBe(true);
      expect(status.resumeRequested).toBe(true);
    } finally {
      await operator.close();
    }
  });

  it("treats close as a rejected operator decision", async () => {
    const manager = new InterventionManager();
    manager.triggerManual({
      runId: "close-run",
      capabilityId: "member.deposit-to-account",
      currentStepId: "confirm-deposit",
      reason: "RISK_APPROVAL_REQUIRED",
      currentRoute: `${origin}/servicing/member/12345/account-transaction-review`,
      lastActionIds: ["confirm-deposit"]
    });
    manager.takeHumanControl();
    const operator = await createOperatorServer(manager, {
      showApproval: true,
      showResume: false,
      ttlSeconds: 60
    });

    try {
      const approval = operator.waitForApproval(5000);
      await fetch(`${operator.url}/close`, { method: "POST" });

      expect(await approval).toBe(false);
    } finally {
      await operator.close();
    }
  });
});
