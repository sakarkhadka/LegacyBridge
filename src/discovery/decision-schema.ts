import { z } from "zod";
import { stepActions } from "../artifact/types.js";

const locatorStrategySchema: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("strategy", [
    z.object({
      strategy: z.literal("accessible"),
      role: z.string().min(1),
      name: z.string().min(1)
    }),
    z.object({
      strategy: z.literal("label"),
      text: z.string().min(1)
    }),
    z.object({
      strategy: z.literal("text"),
      text: z.string().min(1),
      exact: z.boolean().optional()
    }),
    z.object({
      strategy: z.literal("relative"),
      anchorText: z.string().min(1),
      direction: z.enum(["above", "below", "left-of", "right-of", "near"]),
      controlType: z.string().min(1).optional()
    }),
    z.object({
      strategy: z.literal("structural"),
      description: z.string().min(1),
      containerText: z.string().min(1).optional(),
      rowText: z.string().min(1).optional(),
      columnText: z.string().min(1).optional()
    }),
    z.object({
      strategy: z.literal("frame"),
      frameName: z.string().min(1).optional(),
      frameTitle: z.string().min(1).optional(),
      child: locatorStrategySchema
    }),
    z.object({
      strategy: z.literal("coordinates"),
      x: z.number(),
      y: z.number(),
      coordinateSystem: z.enum(["viewport", "screen"])
    })
  ])
);

const targetDescriptorSchema = z.object({
  description: z.string().min(1).optional(),
  primary: locatorStrategySchema,
  fallbacks: z.array(locatorStrategySchema).optional()
});

const actionSchema = z
  .object({
    type: z.enum(stepActions),
    target: targetDescriptorSchema.optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional()
  })
  .superRefine((action, ctx) => {
    if (["click", "fill", "select", "extract"].includes(action.type) && !action.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${action.type} requires a target`,
        path: ["target"]
      });
    }

    if (["navigate", "fill", "select"].includes(action.type) && action.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${action.type} requires a value`,
        path: ["value"]
      });
    }
  });

export const agentDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("act"),
    reason: z.string().min(1),
    action: actionSchema
  }),
  z.object({
    type: z.literal("goal_complete"),
    reason: z.string().min(1),
    outputs: z.record(z.string()).default({})
  }),
  z.object({
    type: z.literal("dead_end"),
    reason: z.string().min(1)
  }),
  z.object({
    type: z.literal("intervention_required"),
    reason: z.string().min(1)
  })
]);

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const agentDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "reason"],
  properties: {
    type: {
      type: "string",
      enum: ["act", "goal_complete", "dead_end", "intervention_required"]
    },
    reason: {
      type: "string"
    },
    outputs: {
      type: "object",
      additionalProperties: {
        type: "string"
      }
    },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: [...stepActions]
        },
        value: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" }
          ]
        },
        target: {
          type: "object",
          additionalProperties: false,
          required: ["primary"],
          properties: {
            description: {
              type: "string"
            },
            primary: {
              anyOf: locatorStrategyJsonSchemas()
            },
            fallbacks: {
              type: "array",
              items: {
                anyOf: locatorStrategyJsonSchemas()
              }
            }
          }
        }
      }
    }
  }
} as const;

function locatorStrategyJsonSchemas() {
  return [
    {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "role", "name"],
      properties: {
        strategy: { const: "accessible" },
        role: { type: "string" },
        name: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "text"],
      properties: {
        strategy: { const: "label" },
        text: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "text"],
      properties: {
        strategy: { const: "text" },
        text: { type: "string" },
        exact: { type: "boolean" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "anchorText", "direction"],
      properties: {
        strategy: { const: "relative" },
        anchorText: { type: "string" },
        direction: { enum: ["above", "below", "left-of", "right-of", "near"] },
        controlType: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "description"],
      properties: {
        strategy: { const: "structural" },
        description: { type: "string" },
        containerText: { type: "string" },
        rowText: { type: "string" },
        columnText: { type: "string" }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "child"],
      properties: {
        strategy: { const: "frame" },
        frameName: { type: "string" },
        frameTitle: { type: "string" },
        child: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["strategy", "role", "name"],
              properties: {
                strategy: { const: "accessible" },
                role: { type: "string" },
                name: { type: "string" }
              }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["strategy", "text"],
              properties: {
                strategy: { const: "label" },
                text: { type: "string" }
              }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["strategy", "description"],
              properties: {
                strategy: { const: "structural" },
                description: { type: "string" },
                containerText: { type: "string" },
                rowText: { type: "string" },
                columnText: { type: "string" }
              }
            }
          ]
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "x", "y", "coordinateSystem"],
      properties: {
        strategy: { const: "coordinates" },
        x: { type: "number" },
        y: { type: "number" },
        coordinateSystem: { enum: ["viewport", "screen"] }
      }
    }
  ];
}
