import { createDemoAppServer } from "../../demo-app/server.js";
import type { TargetDescriptor } from "../artifact/types.js";
import { PlaywrightSurfaceAdapter } from "../surface/playwright/playwright-adapter.js";
import { createPlaywrightSession } from "../surface/playwright/session.js";

const port = Number(process.env.PORT ?? 3100);
const origin = `http://127.0.0.1:${port}`;

const targets: Record<string, TargetDescriptor> = {
  memberNumber: {
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
  },
  searchButton: {
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
  },
  savingsBalance: {
    description: "Savings balance cell",
    primary: {
      strategy: "structural",
      description: "Balance cell in the Accounts table for the Savings row",
      rowText: "Savings",
      columnText: "Balance"
    }
  }
};

const server = createDemoAppServer();
await new Promise<void>((resolve) => {
  server.listen(port, "127.0.0.1", resolve);
});

const session = await createPlaywrightSession({ headless: true });
try {
  const adapter = new PlaywrightSurfaceAdapter({
    page: session.page,
    sessionId: session.id
  });

  await adapter.act({
    type: "navigate",
    value: `${origin}/servicing/search`
  });
  const memberNumber = await adapter.locate(targets.memberNumber);
  const searchButton = await adapter.locate(targets.searchButton);

  await adapter.act({ type: "fill", value: "12345" }, memberNumber);
  await adapter.act({ type: "click" }, searchButton);
  await session.page.waitForURL("**/servicing/member/12345");

  const savingsBalance = await adapter.locate(targets.savingsBalance);
  const extracted = await adapter.act({ type: "extract" }, savingsBalance);

  console.log(JSON.stringify(
    {
      session: adapter.getSession(),
      observation: await adapter.observe(),
      resolvedTargets: {
        memberNumber,
        searchButton,
        savingsBalance
      },
      extractedSavingsBalance: extracted.observed
    },
    null,
    2
  ));
} finally {
  await session.close();
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
