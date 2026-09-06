import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";

let server: DemoAppServer;
let baseUrl: string;

beforeAll(async () => {
  server = createDemoAppServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server to listen on a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

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
});

describe("Heritage Core Servicing demo app", () => {
  it("serves the member search screen without automation-only test IDs", async () => {
    const response = await fetch(`${baseUrl}/servicing/search`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Heritage Core Servicing");
    expect(html).toContain("Member Number");
    expect(html).not.toContain("Maintenance scheduled tonight");
    expect(html).not.toContain("data-testid");
    expect(html).not.toContain("data-test");
  });

  it("shows an active member and account balances inside the accounts frame", async () => {
    const details = await fetch(`${baseUrl}/servicing/member/12345`);
    const detailsHtml = await details.text();
    const frame = await fetch(`${baseUrl}/servicing/member/12345/accounts-frame`);
    const frameHtml = await frame.text();

    expect(details.status).toBe(200);
    expect(detailsHtml).toContain("Member Details");
    expect(detailsHtml).toContain("Open Sub Account");
    expect(detailsHtml).toContain("iframe");
    expect(frame.status).toBe(200);
    expect(frameHtml).toContain("Savings");
    expect(frameHtml).toContain("$3,182.46");
  });

  it("represents member not found as a normal business screen", async () => {
    const response = await fetch(`${baseUrl}/servicing/member/00000`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Member not found");
  });

  it("serves permission denied as a hard runtime condition", async () => {
    const response = await fetch(`${baseUrl}/servicing/member/88888`);
    const html = await response.text();

    expect(response.status).toBe(403);
    expect(html).toContain("Permission denied");
  });

  it("supports deterministic session-expired, interstitial, slow, and app-error scenarios", async () => {
    const sessionExpired = await fetch(`${baseUrl}/servicing/search?scenario=session-expired`);
    const interstitial = await fetch(`${baseUrl}/servicing/member/12345?scenario=interstitial`);
    const appError = await fetch(`${baseUrl}/servicing/search?scenario=error`);
    const slowStartedAt = Date.now();
    const slow = await fetch(`${baseUrl}/servicing/search?scenario=slow`);
    const slowElapsedMs = Date.now() - slowStartedAt;

    expect(sessionExpired.status).toBe(440);
    expect(await sessionExpired.text()).toContain("Session Expired");
    expect(interstitial.status).toBe(200);
    expect(await interstitial.text()).toContain("Maintenance scheduled tonight");
    expect(appError.status).toBe(500);
    expect(await appError.text()).toContain("Application error");
    expect(slow.status).toBe(200);
    expect(slowElapsedMs).toBeGreaterThanOrEqual(700);
  });

  it("contains a risky sub-account confirmation flow", async () => {
    const beforeFrame = await fetch(`${baseUrl}/servicing/member/12345/accounts-frame`);
    const form = await fetch(`${baseUrl}/servicing/member/12345/open-sub-account`);
    const review = await fetch(`${baseUrl}/servicing/member/12345/sub-account-review?accountType=savings&nickname=Reserve`);
    const confirmation = await fetch(`${baseUrl}/servicing/member/12345/sub-account-confirmed?accountType=savings&nickname=Reserve`);
    const afterFrame = await fetch(`${baseUrl}/servicing/member/12345/accounts-frame`);
    const beforeHtml = await beforeFrame.text();
    const afterHtml = await afterFrame.text();

    expect(beforeHtml).not.toContain("S-123403");
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("Open Sub Account");
    expect(review.status).toBe(200);
    expect(await review.text()).toContain("Confirm Opening is irreversible");
    expect(confirmation.status).toBe(200);
    const confirmationHtml = await confirmation.text();
    expect(confirmationHtml).toContain("Sub Account Opening Confirmation");
    expect(confirmationHtml).toContain("New Savings sub-account created");
    expect(confirmationHtml).toContain("S-123403");
    expect(afterHtml).toContain("S-123403");
    expect(afterHtml).toContain("$0.00");
  });

  it("persists created sub-accounts across demo server instances when a state file is used", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "legacybridge-state-"));
    const statePath = join(tempDir, "state.json");
    let firstServer: DemoAppServer | undefined;
    let secondServer: DemoAppServer | undefined;

    try {
      firstServer = createDemoAppServer({ persistState: true, statePath });
      const firstUrl = await listen(firstServer);
      const confirmation = await fetch(`${firstUrl}/servicing/member/12345/sub-account-confirmed?accountType=money-market&nickname=Growth`);
      const confirmationHtml = await confirmation.text();
      expect(confirmation.status).toBe(200);
      expect(confirmationHtml).toContain("New Money Market sub-account created");
      expect(confirmationHtml).toContain("M-123403");

      await closeServer(firstServer);
      firstServer = undefined;

      secondServer = createDemoAppServer({ persistState: true, statePath });
      const secondUrl = await listen(secondServer);
      const frame = await fetch(`${secondUrl}/servicing/member/12345/accounts-frame`);
      const frameHtml = await frame.text();

      expect(frame.status).toBe(200);
      expect(frameHtml).toContain("Money Market");
      expect(frameHtml).toContain("M-123403");
      expect(frameHtml).toContain("$0.00");
    } finally {
      if (firstServer) {
        await closeServer(firstServer);
      }
      if (secondServer) {
        await closeServer(secondServer);
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function listen(server: DemoAppServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server to listen on a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: DemoAppServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
