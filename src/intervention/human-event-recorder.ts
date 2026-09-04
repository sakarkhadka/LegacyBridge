import type { HumanActionRecord } from "./types.js";

export class HumanEventRecorder {
  private readonly actions: HumanActionRecord[] = [];

  constructor(private readonly sensitiveValues: string[] = []) {}

  recordClick(target: string): HumanActionRecord {
    return this.record({
      actor: "human",
      action: "click",
      target,
      timestamp: new Date().toISOString()
    });
  }

  recordInput(target: string, value: string): HumanActionRecord {
    return this.record({
      actor: "human",
      action: "input",
      target,
      timestamp: new Date().toISOString(),
      redactedValue: this.redact(value)
    });
  }

  recordNavigation(target: string): HumanActionRecord {
    return this.record({
      actor: "human",
      action: "navigation",
      target: this.redact(target),
      timestamp: new Date().toISOString()
    });
  }

  list(): HumanActionRecord[] {
    return [...this.actions];
  }

  private record(action: HumanActionRecord): HumanActionRecord {
    this.actions.push(action);
    return action;
  }

  private redact(value: string): string {
    return this.sensitiveValues.reduce((current, sensitive) => {
      if (!sensitive) {
        return current;
      }
      return current.replaceAll(sensitive, "[REDACTED]");
    }, value);
  }
}
