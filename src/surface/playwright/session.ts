import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type PlaywrightSession = {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
};

export async function createPlaywrightSession(options: { headless?: boolean } = {}): Promise<PlaywrightSession> {
  const browser = await chromium.launch({
    headless: options.headless ?? true
  });
  const context = await browser.newContext({
    viewport: {
      width: 1280,
      height: 900
    }
  });
  const page = await context.newPage();
  const id = `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    browser,
    context,
    page,
    async close() {
      await browser.close();
    }
  };
}

