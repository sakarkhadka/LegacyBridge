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
    expect(frameHtml).toContain("Deposit");
    expect(frameHtml).toContain("Withdraw");
    expect(frameHtml).toContain("Transactions");
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

  it("shows the ten most recent transactions for an account", async () => {
    const response = await fetch(`${baseUrl}/servicing/member/12345/account-transactions?accountNumber=S-100234`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Most Recent 10 Transactions");
    expect(html).toContain("S-100234");
    expect(html).toContain("Deposit");
    expect(html).toContain("+$125.00");
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

  it("deposits and withdraws funds from an account balance", async () => {
    const depositReview = await fetch(`${baseUrl}/servicing/member/12345/account-transaction-review?operation=deposit&accountNumber=S-100234&amount=25.00`);
    const depositConfirmation = await fetch(`${baseUrl}/servicing/member/12345/account-transaction-confirmed?operation=deposit&accountNumber=S-100234&amount=25.00`);
    const withdrawalReview = await fetch(`${baseUrl}/servicing/member/12345/account-transaction-review?operation=withdraw&accountNumber=S-100234&amount=10.00`);
    const withdrawalConfirmation = await fetch(`${baseUrl}/servicing/member/12345/account-transaction-confirmed?operation=withdraw&accountNumber=S-100234&amount=10.00`);
    const frame = await fetch(`${baseUrl}/servicing/member/12345/accounts-frame`);
    const transactions = await fetch(`${baseUrl}/servicing/member/12345/account-transactions?accountNumber=S-100234`);

    expect(depositReview.status).toBe(200);
    expect(await depositReview.text()).toContain("Projected Balance");
    expect(depositConfirmation.status).toBe(200);
    expect(await depositConfirmation.text()).toContain("$3,207.46");
    expect(withdrawalReview.status).toBe(200);
    expect(await withdrawalReview.text()).toContain("Withdrawal Review");
    expect(withdrawalConfirmation.status).toBe(200);
    expect(await withdrawalConfirmation.text()).toContain("$3,197.46");
    expect(await frame.text()).toContain("$3,197.46");
    const transactionsHtml = await transactions.text();
    expect(transactionsHtml).toContain("-$10.00");
    expect(transactionsHtml).toContain("+$25.00");
  });

  it("reports invalid transaction requests as business screens", async () => {
    const invalidAmount = await fetch(`${baseUrl}/servicing/member/12345/account-transaction-review?operation=deposit&accountNumber=S-100234&amount=0`);
    const insufficientFunds = await fetch(`${baseUrl}/servicing/member/12345/account-transaction-review?operation=withdraw&accountNumber=C-442910&amount=900.00`);

    expect(invalidAmount.status).toBe(200);
    expect(await invalidAmount.text()).toContain("Invalid amount");
    expect(insufficientFunds.status).toBe(200);
    expect(await insufficientFunds.text()).toContain("Insufficient funds");
  });

  it("uses account number to mutate the intended account when duplicate account types exist", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "legacybridge-duplicate-savings-"));
    const statePath = join(tempDir, "state.json");
    let persistentServer: DemoAppServer | undefined;

    try {
      persistentServer = createDemoAppServer({ persistState: true, statePath });
      const persistentUrl = await listen(persistentServer);
      await fetch(`${persistentUrl}/servicing/member/12345/sub-account-confirmed?accountType=savings&nickname=Reserve`);
      const deposit = await fetch(`${persistentUrl}/servicing/member/12345/account-transaction-confirmed?operation=deposit&accountNumber=S-123403&amount=25.00`);
      const frame = await fetch(`${persistentUrl}/servicing/member/12345/accounts-frame`);
      const frameHtml = await frame.text();

      expect(deposit.status).toBe(200);
      expect(await deposit.text()).toContain("$25.00");
      expect(frameHtml).toContain("S-100234</td>\n          <td class=\"amount\">$3,182.46");
      expect(frameHtml).toContain("S-123403</td>\n          <td class=\"amount\">$25.00");
    } finally {
      if (persistentServer) {
        await closeServer(persistentServer);
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
