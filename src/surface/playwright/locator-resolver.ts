import type { Frame, Locator, Page } from "playwright";
import type {
  LocatorStrategy,
  StructuralLocator,
  TargetDescriptor
} from "../../artifact/types.js";
import type { ResolvedTarget } from "../types.js";

export type PlaywrightResolvedTarget = ResolvedTarget & {
  locator: Locator;
};

type Candidate = {
  locator: Locator;
  matchCount: number;
  strategyUsed: string;
  confidence: number;
  fallbackUsed: boolean;
};

export class PlaywrightLocatorResolver {
  constructor(private readonly page: Page) {}

  async resolve(target: TargetDescriptor): Promise<PlaywrightResolvedTarget> {
    const strategies = [target.primary, ...(target.fallbacks ?? [])];

    for (const [index, strategy] of strategies.entries()) {
      const candidate = await this.resolveStrategy(strategy, index > 0);
      if (candidate.matchCount === 1) {
        return withHiddenLocator({
          descriptor: target,
          strategyUsed: candidate.strategyUsed,
          confidence: candidate.confidence,
          matchCount: candidate.matchCount,
          fallbackUsed: candidate.fallbackUsed,
        }, candidate.locator);
      }
    }

    const lastCandidate = await this.resolveStrategy(target.primary, false);
    return withHiddenLocator({
      descriptor: target,
      strategyUsed: lastCandidate.strategyUsed,
      confidence: 0,
      matchCount: lastCandidate.matchCount,
      fallbackUsed: false,
    }, lastCandidate.locator);
  }

  private async resolveStrategy(strategy: LocatorStrategy, fallbackUsed: boolean): Promise<Candidate> {
    switch (strategy.strategy) {
      case "accessible":
        return this.fromLocator(this.page.getByRole(strategy.role as never, { name: strategy.name }), strategy.strategy, fallbackUsed, 0.95);
      case "label":
        return this.fromLocator(this.page.getByLabel(strategy.text), strategy.strategy, fallbackUsed, 0.9);
      case "text":
        return this.fromLocator(this.page.getByText(strategy.text, { exact: strategy.exact }), strategy.strategy, fallbackUsed, 0.78);
      case "relative":
        return this.resolveRelative(strategy, fallbackUsed);
      case "structural":
        return this.resolveStructural(strategy, fallbackUsed);
      case "frame":
        return this.resolveFrame(strategy, fallbackUsed);
      case "coordinates":
        return this.fromLocator(this.page.locator("body"), strategy.strategy, fallbackUsed, 0.2);
    }
  }

  private async resolveStructural(strategy: StructuralLocator, fallbackUsed: boolean): Promise<Candidate> {
    for (const frame of this.page.frames()) {
      const candidate = await structuralCandidateInFrame(frame, strategy);
      if (candidate.matchCount > 0) {
        return {
          ...candidate,
          strategyUsed: "structural",
          confidence: candidate.matchCount === 1 ? 0.82 : 0.42,
          fallbackUsed
        };
      }
    }

    return {
      locator: this.page.locator("body").locator("__legacybridge_no_match__"),
      matchCount: 0,
      strategyUsed: "structural",
      confidence: 0,
      fallbackUsed
    };
  }

  private async resolveRelative(strategy: Extract<LocatorStrategy, { strategy: "relative" }>, fallbackUsed: boolean): Promise<Candidate> {
    const controlLocator = controlLocatorFor(strategy.controlType);
    const formNearAnchor = this.page.locator("form").filter({
      hasText: strategy.anchorText
    });
    const scopedControl = formNearAnchor.locator(controlLocator).first();
    const scopedCount = await scopedControl.count();

    if (scopedCount > 0) {
      return {
        locator: scopedControl,
        matchCount: 1,
        strategyUsed: "relative",
        confidence: 0.72,
        fallbackUsed
      };
    }

    return this.fromLocator(this.page.getByText(strategy.anchorText).locator("..").locator(controlLocator).first(), strategy.strategy, fallbackUsed, 0.58);
  }

  private async resolveFrame(strategy: Extract<LocatorStrategy, { strategy: "frame" }>, fallbackUsed: boolean): Promise<Candidate> {
    const frame = this.page
      .frames()
      .find((candidate) => {
        const matchesName = strategy.frameName ? candidate.name() === strategy.frameName : true;
        const matchesTitle = strategy.frameTitle ? candidate.url().includes(strategy.frameTitle) : true;
        return matchesName && matchesTitle;
      });

    if (!frame) {
      return {
        locator: this.page.locator("body").locator("__legacybridge_no_frame__"),
        matchCount: 0,
        strategyUsed: "frame",
        confidence: 0,
        fallbackUsed
      };
    }

    const nested = await strategyCandidateInFrame(frame, strategy.child);
    return {
      ...nested,
      strategyUsed: `frame:${nested.strategyUsed}`,
      fallbackUsed
    };
  }

  private async fromLocator(locator: Locator, strategyUsed: string, fallbackUsed: boolean, confidence: number): Promise<Candidate> {
    const matchCount = await locator.count();
    return {
      locator: locator.first(),
      matchCount,
      strategyUsed,
      confidence: matchCount === 1 ? confidence : 0.35,
      fallbackUsed
    };
  }
}

async function strategyCandidateInFrame(frame: Frame, strategy: LocatorStrategy): Promise<Candidate> {
  switch (strategy.strategy) {
    case "accessible":
      return fromFrameLocator(frame.getByRole(strategy.role as never, { name: strategy.name }), "accessible", 0.95);
    case "label":
      return fromFrameLocator(frame.getByLabel(strategy.text), "label", 0.9);
    case "text":
      return fromFrameLocator(frame.getByText(strategy.text, { exact: strategy.exact }), "text", 0.78);
    case "structural":
      return {
        ...(await structuralCandidateInFrame(frame, strategy)),
        fallbackUsed: false
      };
    case "relative":
      return fromFrameLocator(frame.locator("form").filter({ hasText: strategy.anchorText }).locator(controlLocatorFor(strategy.controlType)).first(), "relative", 0.58);
    case "coordinates":
      return fromFrameLocator(frame.locator("body"), "coordinates", 0.2);
    case "frame":
      return fromFrameLocator(frame.locator("body").locator("__legacybridge_nested_frame_not_supported__"), "frame", 0);
  }
}

function withHiddenLocator(target: ResolvedTarget, locator: Locator): PlaywrightResolvedTarget {
  Object.defineProperty(target, "locator", {
    value: locator,
    enumerable: false
  });
  return target as PlaywrightResolvedTarget;
}

function controlLocatorFor(controlType: string | undefined): string {
  switch (controlType) {
    case "submit button":
      return "button[type='submit'],input[type='submit']";
    case "reset button":
      return "button[type='reset'],input[type='reset']";
    case "link":
      return "a";
    case "select":
      return "select";
    case "input":
      return "input,textarea";
    case "button":
    case undefined:
      return "button,input[type='button'],input[type='submit'],a";
    default:
      return "input,button,select,textarea,a";
  }
}

async function fromFrameLocator(locator: Locator, strategyUsed: string, confidence: number): Promise<Candidate> {
  const matchCount = await locator.count();
  return {
    locator: locator.first(),
    matchCount,
    strategyUsed,
    confidence: matchCount === 1 ? confidence : 0.35,
    fallbackUsed: false
  };
}

async function structuralCandidateInFrame(frame: Frame, strategy: StructuralLocator): Promise<Omit<Candidate, "fallbackUsed">> {
  const tables = frame.locator("table");
  const tableCount = await tables.count();
  const relaxedStrategy = strategy.containerText
    ? {
      ...strategy,
      containerText: undefined
    }
    : undefined;

  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const table = tables.nth(tableIndex);
    const tableText = await table.innerText().catch(() => "");
    if (strategy.containerText && !tableText.includes(strategy.containerText)) {
      continue;
    }

    const headerCells = table.locator("tr").first().locator("th,td");
    const headerCount = await headerCells.count();
    let targetColumn = -1;
    for (let columnIndex = 0; columnIndex < headerCount; columnIndex += 1) {
      const headerText = (await headerCells.nth(columnIndex).innerText()).trim();
      if (!strategy.columnText || headerText === strategy.columnText) {
        targetColumn = columnIndex;
        break;
      }
    }

    const rows = table.locator("tr");
    const rowCount = await rows.count();
    for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
      const row = rows.nth(rowIndex);
      const rowText = await row.innerText();
      if (strategy.rowText && !rowText.includes(strategy.rowText)) {
        continue;
      }
      const cells = row.locator("td,th");
      const cellCount = await cells.count();
      const cell = targetColumn >= 0 && targetColumn < cellCount ? cells.nth(targetColumn) : cells.last();
      return {
        locator: cell,
        matchCount: 1,
        strategyUsed: "structural",
        confidence: 0.82
      };
    }
  }

  if (relaxedStrategy) {
    return structuralCandidateInFrame(frame, relaxedStrategy);
  }

  return {
    locator: frame.locator("body").locator("__legacybridge_no_structural_match__"),
    matchCount: 0,
    strategyUsed: "structural",
    confidence: 0
  };
}
