import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvidenceEvent, EvidenceEventName, EvidencePayload } from "./events.js";
import { redactLogEvent } from "../policy/redaction.js";

export interface EvidenceSink {
  append(event: EvidenceEvent): Promise<void>;
}

export class JsonlEvidenceSink implements EvidenceSink {
  constructor(private readonly path: string) {}

  async append(event: EvidenceEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a"
    });
  }
}

export class MemoryEvidenceSink implements EvidenceSink {
  readonly events: EvidenceEvent[] = [];

  async append(event: EvidenceEvent): Promise<void> {
    this.events.push(event);
  }
}

export class EvidenceRecorder {
  constructor(
    private readonly options: {
      runId: string;
      capabilityId?: string;
      sensitiveValues?: string[];
      sink: EvidenceSink;
    }
  ) {}

  async record(event: EvidenceEventName, data: {
    stepId?: string;
    payload?: EvidencePayload;
  } = {}): Promise<void> {
    const raw: EvidenceEvent = {
      event,
      timestamp: new Date().toISOString(),
      runId: this.options.runId,
      capabilityId: this.options.capabilityId,
      stepId: data.stepId,
      data: data.payload
    };
    await this.options.sink.append(redactLogEvent(raw, this.options.sensitiveValues ?? []));
  }
}

export async function resetJsonlEvidenceFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
}
