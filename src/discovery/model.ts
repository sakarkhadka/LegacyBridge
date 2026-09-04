import OpenAI from "openai";
import type { AgentDecision } from "./decision-schema.js";
import { agentDecisionJsonSchema, agentDecisionSchema } from "./decision-schema.js";
import type { DiscoveryContext } from "./run-state.js";

export interface DiscoveryModel {
  decide(context: DiscoveryContext): Promise<AgentDecision>;
}

export class OpenAIDiscoveryModel implements DiscoveryModel {
  private readonly client: OpenAI;

  constructor(
    private readonly options: {
      apiKey?: string;
      model?: string;
    } = {}
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY
    });
  }

  async decide(context: DiscoveryContext): Promise<AgentDecision> {
    const response = await this.client.responses.create({
      model: this.options.model ?? process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "developer",
          content: context.systemPrompt
        },
        {
          role: "user",
          content: context.userPrompt
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "agent_decision",
          strict: false,
          schema: agentDecisionJsonSchema
        }
      }
    });

    const text = response.output_text;
    if (!text) {
      throw new Error("Model returned no output_text");
    }

    return agentDecisionSchema.parse(normalizeDecision(JSON.parse(text)));
  }
}

export class ScriptedDiscoveryModel implements DiscoveryModel {
  private index = 0;

  constructor(private readonly decisions: AgentDecision[]) {}

  async decide(): Promise<AgentDecision> {
    const decision = this.decisions[this.index];
    if (!decision) {
      return {
        type: "dead_end",
        reason: "scripted model exhausted"
      };
    }
    this.index += 1;
    return decision;
  }
}

function normalizeDecision(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const decision = structuredClone(value) as {
    action?: {
      target?: Record<string, unknown>;
    };
  };

  if (decision.action?.target && Object.keys(decision.action.target).length === 0) {
    delete decision.action.target;
  }

  return decision;
}
