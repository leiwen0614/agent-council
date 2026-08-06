import { z } from "zod";
import type { ProviderConfig } from "./types.js";

const providerIdSchema = z.enum(["codex", "claude", "copilot"]);
const stageSchema = z.enum(["initial", "review", "final"]);
const providerStatusSchema = z.enum([
  "waiting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked_by_approval",
  "skipped"
]);

const modelSchema = z.string().trim().min(1).max(200).nullable();
const providerConfigFields = { yolo: z.boolean(), model: modelSchema };
const codexProviderConfigSchema = z
  .object({
    ...providerConfigFields,
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable()
  })
  .strict();
const claudeProviderConfigSchema = z
  .object({
    ...providerConfigFields,
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable()
  })
  .strict();
const copilotProviderConfigSchema = z
  .object({
    ...providerConfigFields,
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable()
  })
  .strict();
const partialModelSchema = modelSchema.optional();
const partialCodexProviderConfigSchema = z
  .object({
    yolo: z.boolean().optional(),
    model: partialModelSchema,
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional()
  })
  .strict();
const partialClaudeProviderConfigSchema = z
  .object({
    yolo: z.boolean().optional(),
    model: partialModelSchema,
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional()
  })
  .strict();
const partialCopilotProviderConfigSchema = z
  .object({
    yolo: z.boolean().optional(),
    model: partialModelSchema,
    effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional()
  })
  .strict();

const persistedModelSchema = modelSchema.optional();
const persistedCodexProviderConfigSchema = z
  .object({
    yolo: z.boolean(),
    model: persistedModelSchema,
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional()
  })
  .strict()
  .transform((value): ProviderConfig => ({
    yolo: value.yolo,
    model: value.model ?? null,
    effort: value.effort ?? null
  }));
const persistedClaudeProviderConfigSchema = z
  .object({
    yolo: z.boolean(),
    model: persistedModelSchema,
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional()
  })
  .strict()
  .transform((value): ProviderConfig => ({
    yolo: value.yolo,
    model: value.model ?? null,
    effort: value.effort ?? null
  }));
const persistedCopilotProviderConfigSchema = z
  .object({
    yolo: z.boolean(),
    model: persistedModelSchema,
    effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional()
  })
  .strict()
  .transform((value): ProviderConfig => ({
    yolo: value.yolo,
    model: value.model ?? null,
    effort: value.effort ?? null
  }));
const enabledProvidersSchema = z
  .array(providerIdSchema)
  .min(2)
  .max(3)
  .refine((providers) => new Set(providers).size === providers.length, {
    message: "Enabled providers must be unique."
  });

export const partialCouncilConfigSchema = z
  .object({
    enabledProviders: enabledProvidersSchema.optional(),
    agents: z
      .object({
        codex: partialCodexProviderConfigSchema.optional(),
        claude: partialClaudeProviderConfigSchema.optional(),
        copilot: partialCopilotProviderConfigSchema.optional()
      })
      .strict()
      .optional(),
    ui: z
      .object({ maxPanelLines: z.number().int().min(3).max(200).optional() })
      .strict()
      .optional()
  })
  .strict();

export const councilConfigSchema = z
  .object({
    enabledProviders: enabledProvidersSchema,
    agents: z
      .object({
        codex: codexProviderConfigSchema,
        claude: claudeProviderConfigSchema,
        copilot: copilotProviderConfigSchema
      })
      .strict(),
    ui: z.object({ maxPanelLines: z.number().int().min(3).max(200) }).strict()
  })
  .strict();

const providerSessionSchema = z
  .object({ sessionId: z.string().min(1).nullable(), updatedAt: z.string().datetime() })
  .strict();

export const councilSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    name: z.string().min(1).max(100).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    originalProjectRoot: z.string().min(1),
    activeRunId: z.string().min(1).nullable(),
    providers: z
      .object({
        codex: providerSessionSchema,
        claude: providerSessionSchema,
        copilot: providerSessionSchema
      })
      .strict()
  })
  .strict();

const attemptSchema = z
  .object({
    number: z.number().int().positive(),
    status: z.enum(["completed", "failed", "cancelled", "blocked_by_approval"]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    error: z.string().optional()
  })
  .strict();

const providerStageSchema = z
  .object({
    status: providerStatusSchema,
    attempts: z.array(attemptSchema),
    artifact: z.string().min(1),
    error: z.string().optional()
  })
  .strict();

const providersStageSchema = z
  .object({ codex: providerStageSchema, claude: providerStageSchema, copilot: providerStageSchema })
  .strict();

const stageStateSchema = z
  .object({
    status: z.enum(["pending", "running", "completed", "partial", "cancelled"]),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    providers: providersStageSchema
  })
  .strict();

const reviewMappingSchema = z
  .object({
    labels: z.array(z.object({ label: z.string().min(1), provider: providerIdSchema }).strict()),
    displayOrder: z.array(z.string().min(1))
  })
  .strict();

const reviewMappingsSchema = z
  .object({
    codex: reviewMappingSchema.optional(),
    claude: reviewMappingSchema.optional(),
    copilot: reviewMappingSchema.optional()
  })
  .strict();

export const councilRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    sessionId: z.string().uuid(),
    status: z.enum([
      "initial_pending",
      "initial_running",
      "initial_recovery",
      "review_pending",
      "review_running",
      "review_recovery",
      "final_pending",
      "final_running",
      "final_recovery",
      "awaiting_decision",
      "completed",
      "abandoned"
    ]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    eventSequence: z.number().int().nonnegative(),
    degraded: z.boolean(),
    effectiveConfig: z
      .object({
        enabledProviders: enabledProvidersSchema,
        agents: z
          .object({
            codex: persistedCodexProviderConfigSchema,
            claude: persistedClaudeProviderConfigSchema,
            copilot: persistedCopilotProviderConfigSchema
          })
          .strict()
      })
      .strict(),
    stages: z
      .object({ initial: stageStateSchema, review: stageStateSchema, final: stageStateSchema })
      .strict(),
    reviewMappings: reviewMappingsSchema,
    degradedContinuations: z.array(
      z
        .object({
          stage: stageSchema,
          continuedAt: z.string().datetime(),
          included: z.array(z.string()),
          omitted: z.array(z.string())
        })
        .strict()
    )
  })
  .strict();

export const councilDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    selectedAgent: providerIdSchema.nullable(),
    decision: z.string().min(1),
    sources: z.array(z.string().min(1)).min(1),
    decidedAt: z.string().datetime()
  })
  .strict();

export const councilEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    sessionId: z.string().uuid(),
    runId: z.string().min(1),
    stage: stageSchema,
    provider: providerIdSchema.nullable(),
    kind: z.enum([
      "stage.started",
      "stage.completed",
      "stage.partial",
      "provider.started",
      "provider.progress",
      "provider.prose",
      "provider.completed",
      "provider.failed",
      "provider.cancelled",
      "provider.skipped",
      "diagnostic"
    ]),
    text: z.string().optional(),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
  })
  .strict();
