import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoAppServer, type DemoAppServer } from "../demo-app/server.js";
import type { TargetDescriptor } from "../src/artifact/types.js";
import { PlaywrightSurfaceAdapter } from "../src/surface/playwright/playwright-adapter.js";
import { createPlaywrightSession, type PlaywrightSession } from "../src/surface/playwright/session.js";

let server: DemoAppServer;
let session: PlaywrightSession;
let adapter: PlaywrightSurfaceAdapter;
let baseUrl: string;

const memberNumberTarget: TargetDescriptor = {
  description: "Member Number field",
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
};

const searchButtonTarget: TargetDescriptor = {
  description: "Search button",
  primary: {
    strategy: "relative",
    anchorText: "Member Number",
    direction: "below",
    controlType: "submit button"
  },
  fallbacks: [
    {
      strategy: "accessible",
      role: "button",
      name: "Search"
    }
  ]
};

const savingsBalanceTarget: TargetDescriptor = {
  description: "Savings balance cell",
  primary: {
    strategy: "structural",
    description: "Balance cell in the Accounts table for the Savings row",
    rowText: "Savings",
    columnText: "Balance"
  }
};

beforeAll(async () => {
  server = createDemoAppServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected demo app to listen on a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  session = await createPlaywrightSession({ headless: true });
  adapter = new PlaywrightSurfaceAdapter({
    page: session.page,
    sessionId: session.id
  });
}, 30_000);

afterAll(async () => {
  await session?.close();
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

describe("Playwright surface adapter", () => {
  it("observes a live browser surface without exposing raw DOM as the only representation", async () => {
    await adapter.act({ type: "navigate", value: `${baseUrl}/servicing/search` });

    const observation = await adapter.observe();

    expect(observation.url).toContain("/servicing/search");
    expect(observation.title).toContain("Heritage Core Servicing");
    expect(observation.visibleText).toContain("Member Search");
    expect(observation.frames).toEqual(expect.any(Array));
  });

  it("locates the Member Number field and Search button using TargetDescriptor contracts", async () => {
    await adapter.act({ type: "navigate", value: `${baseUrl}/servicing/search` });

    const memberNumber = await adapter.locate(memberNumberTarget);
    const searchButton = await adapter.locate(searchButtonTarget);

    expect(memberNumber.strategyUsed).toBe("label");
    expect(memberNumber.matchCount).toBe(1);
    expect(memberNumber.confidence).toBeGreaterThan(0.8);
    expect(searchButton.strategyUsed).toBe("relative");
    expect(searchButton.matchCount).toBe(1);
  });

  it("locates and extracts the Savings balance cell inside the accounts iframe", async () => {
    await adapter.act({ type: "navigate", value: `${baseUrl}/servicing/search` });
    const memberNumber = await adapter.locate(memberNumberTarget);
    const searchButton = await adapter.locate(searchButtonTarget);

    await adapter.act({ type: "fill", value: "12345" }, memberNumber);
    await adapter.act({ type: "click" }, searchButton);
    await session.page.waitForURL("**/servicing/member/12345");

    const balanceCell = await adapter.locate(savingsBalanceTarget);
    const extraction = await adapter.act({ type: "extract" }, balanceCell);

    expect(balanceCell.strategyUsed).toBe("structural");
    expect(balanceCell.matchCount).toBe(1);
    expect(balanceCell.fallbackUsed).toBe(false);
    expect(extraction).toEqual({
      ok: true,
      observed: "$3,182.46"
    });
  });
});
