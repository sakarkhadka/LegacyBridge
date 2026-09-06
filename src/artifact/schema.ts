import { z } from "zod";
import { capabilityStatuses, stepActions, valueTypes, type CapabilityArtifact } from "./types.js";
import { failureClasses } from "../replay/errors.js";

const moneyValueSchema = z.object({
  amount: z.number(),
  currency: z.string().length(3)
});

const valueTypeSchema = z.enum(valueTypes);

const inputDefinitionSchema = z
  .object({
    type: valueTypeSchema,
    required: z.boolean(),
    sensitive: z.boolean().optional(),
    description: z.string().min(1),
    pattern: z.string().min(1).optional(),
    enumValues: z.array(z.string().min(1)).nonempty().optional()
  })
  .superRefine((input, ctx) => {
    if (input.type === "enum" && !input.enumValues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "enum inputs must declare enumValues",
        path: ["enumValues"]
      });
    }
  });

const outputDefinitionSchema = z.object({
  type: valueTypeSchema,
  required: z.boolean(),
  description: z.string().min(1).optional()
});

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
      columnText: z.string().min(1).optional(),
      controlText: z.string().min(1).optional()
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

const targetDescriptorSchema: z.ZodTypeAny = z.object({
  id: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  primary: locatorStrategySchema,
  fallbacks: z.array(locatorStrategySchema).optional()
});

const conditionDefinitionSchema: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("url_contains"),
      value: z.string().min(1)
    }),
    z.object({
      type: z.literal("title_contains"),
      value: z.string().min(1)
    }),
    z.object({
      type: z.literal("text_present"),
      value: z.string().min(1)
    }),
    z.object({
      type: z.literal("target_visible"),
      target: targetDescriptorSchema
    }),
    z.object({
      type: z.literal("output_present"),
      output: z.string().min(1)
    })
  ])
);

const waitDefinitionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigation"),
    timeoutMs: z.number().int().positive().optional()
  }),
  z.object({
    type: z.literal("element"),
    target: targetDescriptorSchema,
    state: z.enum(["visible", "hidden"]),
    timeoutMs: z.number().int().positive().optional()
  }),
  z.object({
    type: z.literal("text"),
    text: z.string().min(1),
    timeoutMs: z.number().int().positive().optional()
  }),
  z.object({
    type: z.literal("checkpoint"),
    timeoutMs: z.number().int().positive().optional()
  })
]);

const valueSourceSchema = z.union([
  z.object({
    parameter: z.string().min(1)
  }),
  z.object({
    literal: z.union([z.string(), z.number(), z.boolean(), moneyValueSchema])
  })
]);

const outputExtractionSchema = z.object({
  name: z.string().min(1),
  parseAs: valueTypeSchema,
  source: targetDescriptorSchema.optional()
});

const stepRecoverySchema = z.object({
  retries: z
    .object({
      maxAttempts: z.number().int().min(0),
      backoffMs: z.number().int().min(0)
    })
    .optional(),
  knownDialogs: z
    .array(
      z.object({
        title: z.string().min(1),
        response: z.enum(["dismiss", "accept", "route_to_human"])
      })
    )
    .optional(),
  onFailure: z
    .object({
      class: z.enum(failureClasses),
      routeToHuman: z.boolean().optional()
    })
    .optional()
});

const capabilityStepSchema = z.object({
  id: z.string().min(1),
  action: z.enum(stepActions),
  target: targetDescriptorSchema.optional(),
  value: valueSourceSchema.optional(),
  risk: z.enum(["READ_ONLY", "REVERSIBLE_WRITE", "IRREVERSIBLE_WRITE"]).optional(),
  wait: waitDefinitionSchema.optional(),
  precondition: z.array(conditionDefinitionSchema).optional(),
  postcondition: z.array(conditionDefinitionSchema).optional(),
  output: outputExtractionSchema.optional(),
  recovery: stepRecoverySchema.optional()
});

const businessOutcomeDefinitionSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  when: z.array(conditionDefinitionSchema).nonempty()
});

const checkpointDefinitionSchema = z.object({
  description: z.string().min(1),
  conditions: z.array(conditionDefinitionSchema).nonempty()
});

const surfaceFingerprintSchema = z.object({
  titlePatterns: z.array(z.string().min(1)).optional(),
  routePatterns: z.array(z.string().min(1)).optional(),
  landmarks: z.array(z.string().min(1)).optional()
});

const applicationCompatibilitySchema = z.object({
  vendor: z.string().min(1),
  application: z.string().min(1),
  supportedVersions: z.array(z.string().min(1)).optional(),
  fingerprint: surfaceFingerprintSchema.optional()
});

const capabilityPolicySchema = z.object({
  allowedOrigins: z.array(z.string().min(1)).nonempty(),
  allowedRoutes: z.array(z.string().min(1)).nonempty(),
  allowedActions: z.array(z.enum(stepActions)).nonempty(),
  risk: z.enum(["READ_ONLY", "REVERSIBLE_WRITE", "IRREVERSIBLE_WRITE"]),
  approvalRequired: z.boolean().optional()
});

const capabilityValidationSchema = z.object({
  runs: z.number().int().positive(),
  successes: z.number().int().min(0),
  failures: z.number().int().min(0),
  primaryLocatorUsage: z.number().min(0).max(1),
  fallbackLocatorUsage: z.number().min(0).max(1),
  lastValidatedAt: z.string().datetime()
}).superRefine((validation, ctx) => {
  if (validation.successes + validation.failures !== validation.runs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "validation successes plus failures must equal runs",
      path: ["runs"]
    });
  }
});

export const capabilityArtifactSchema = z
  .object({
    schemaVersion: z.string().min(1),
    capability: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
      status: z.enum(capabilityStatuses)
    }),
    targetApplication: applicationCompatibilitySchema,
    inputs: z.record(inputDefinitionSchema),
    outputs: z.record(outputDefinitionSchema),
    outcomes: z.array(businessOutcomeDefinitionSchema),
    steps: z.array(capabilityStepSchema).nonempty(),
    checkpoint: checkpointDefinitionSchema,
    policy: capabilityPolicySchema,
    validation: capabilityValidationSchema.optional()
  })
  .superRefine((artifact, ctx) => {
    const inputNames = new Set(Object.keys(artifact.inputs));
    const outputNames = new Set(Object.keys(artifact.outputs));
    const stepIds = new Set<string>();

    for (const [index, step] of artifact.steps.entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step id: ${step.id}`,
          path: ["steps", index, "id"]
        });
      }
      stepIds.add(step.id);

      if (step.value && "parameter" in step.value && !inputNames.has(step.value.parameter)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step references unknown input parameter: ${step.value.parameter}`,
          path: ["steps", index, "value", "parameter"]
        });
      }

      if (step.output && !outputNames.has(step.output.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step references unknown output: ${step.output.name}`,
          path: ["steps", index, "output", "name"]
        });
      }

      if (step.output && step.output.parseAs !== artifact.outputs[step.output.name]?.type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `step output parser does not match declared output type: ${step.output.name}`,
          path: ["steps", index, "output", "parseAs"]
        });
      }
    }

    validateConditionOutputs(artifact.checkpoint.conditions, outputNames, ctx, ["checkpoint", "conditions"]);

    for (const [index, outcome] of artifact.outcomes.entries()) {
      validateConditionOutputs(outcome.when, outputNames, ctx, ["outcomes", index, "when"]);
    }
  });

export type CapabilityArtifactInput = z.input<typeof capabilityArtifactSchema>;

export function parseCapabilityArtifact(input: unknown): CapabilityArtifact {
  return capabilityArtifactSchema.parse(input) as CapabilityArtifact;
}

export function isCapabilityArtifact(input: unknown): input is CapabilityArtifact {
  return capabilityArtifactSchema.safeParse(input).success;
}

function validateConditionOutputs(
  conditions: Array<{ type: string; output?: string }>,
  outputNames: Set<string>,
  ctx: z.RefinementCtx,
  path: Array<string | number>
): void {
  for (const [index, condition] of conditions.entries()) {
    if (condition.type === "output_present" && condition.output && !outputNames.has(condition.output)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `condition references unknown output: ${condition.output}`,
        path: [...path, index, "output"]
      });
    }
  }
}
