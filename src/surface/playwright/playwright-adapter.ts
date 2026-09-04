import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { TargetDescriptor } from "../../artifact/types.js";
import type {
  ActionResult,
  EvidenceReference,
  ResolvedTarget,
  SessionHandle,
  SurfaceAction,
  SurfaceAdapter,
  SurfaceObservation
} from "../types.js";
import { PlaywrightLocatorResolver, type PlaywrightResolvedTarget } from "./locator-resolver.js";

export class PlaywrightSurfaceAdapter implements SurfaceAdapter {
  private readonly resolver: PlaywrightLocatorResolver;
  private readonly dialogs: SurfaceObservation["dialogs"] = [];

  constructor(
    private readonly options: {
      page: Page;
      sessionId: string;
      evidenceDir?: string;
    }
  ) {
    this.resolver = new PlaywrightLocatorResolver(options.page);
    this.options.page.on("dialog", (dialog) => {
      this.dialogs.push({
        title: dialog.type(),
        message: dialog.message()
      });
    });
  }

  async observe(): Promise<SurfaceObservation> {
    const page = this.options.page;
    const visibleText = await page
      .locator("body")
      .innerText()
      .then((text) => text.split("\n").map((line) => line.trim()).filter(Boolean))
      .catch(() => []);

    return {
      url: page.url(),
      title: await page.title(),
      visibleText,
      dialogs: [...this.dialogs],
      frames: page.frames().map((frame) => ({
        name: frame.name() || undefined,
        url: frame.url()
      })),
      controls: await collectControls(page)
    };
  }

  async locate(target: TargetDescriptor): Promise<ResolvedTarget> {
    return this.resolver.resolve(target);
  }

  async act(action: SurfaceAction, target?: ResolvedTarget): Promise<ActionResult> {
    const page = this.options.page;
    const resolved = target as PlaywrightResolvedTarget | undefined;

    switch (action.type) {
      case "navigate":
        if (typeof action.value !== "string") {
          return { ok: false, observed: "navigate requires a string URL value" };
        }
        await page.goto(action.value);
        return { ok: true, observed: page.url() };
      case "click":
        if (!resolved) {
          return { ok: false, observed: "click requires a resolved target" };
        }
        await resolved.locator.click();
        return { ok: true };
      case "fill":
        if (!resolved || typeof action.value !== "string") {
          return { ok: false, observed: "fill requires a resolved target and string value" };
        }
        await resolved.locator.fill(action.value);
        return { ok: true, observed: "filled target" };
      case "select":
        if (!resolved || typeof action.value !== "string") {
          return { ok: false, observed: "select requires a resolved target and string value" };
        }
        await resolved.locator.selectOption(action.value);
        return { ok: true, observed: "selected target option" };
      case "extract":
        if (!resolved) {
          return { ok: false, observed: "extract requires a resolved target" };
        }
        return {
          ok: true,
          observed: (await resolved.locator.innerText()).trim()
        };
      case "wait":
        await page.waitForLoadState("domcontentloaded");
        return { ok: true };
    }
  }

  async captureEvidence(): Promise<EvidenceReference> {
    const evidenceDir = this.options.evidenceDir ?? "evidence/tmp";
    await mkdir(evidenceDir, { recursive: true });
    const id = `screenshot-${Date.now()}`;
    const path = join(evidenceDir, `${id}.png`);
    await this.options.page.screenshot({ path, fullPage: true });
    return {
      id,
      kind: "screenshot",
      path,
      redacted: false
    };
  }

  getSession(): SessionHandle {
    return {
      id: this.options.sessionId,
      surface: "browser"
    };
  }
}

async function collectControls(page: Page): Promise<SurfaceObservation["controls"]> {
  const controls: NonNullable<SurfaceObservation["controls"]> = [];
  for (const frame of page.frames()) {
    controls.push(
      ...(await frame.locator("input, textarea, select, button, a").evaluateAll((elements) =>
        elements.map((element) => {
          const htmlElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement | HTMLAnchorElement;
          const id = htmlElement.id;
          const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : undefined;
          return {
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute("type") ?? undefined,
            label,
            text: element.textContent?.trim() || undefined,
            value: "value" in htmlElement ? htmlElement.value : undefined
          };
        })
      ).catch(() => []))
    );
  }

  return controls;
}
