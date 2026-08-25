import { z } from "zod";
import { BLIND_CANDIDATE_IDS, type EvaluatorOutput } from "./evaluation-types.js";

const providerIdSchema = z.enum(["codex", "claude", "copilot"]);
const blindCandidateIdSchema = z.enum(["Candidate A", "Candidate B", "Candidate C"]);

function hasAtMostOneDecimalPlace(value: number): boolean {
  const tenths = value * 10;
  return Math.abs(tenths - Math.round(tenths)) < 1e-9;
}

const dimensionScoreSchema = z
  .object({
    score: z
      .number()
      .finite()
      .min(0)
      .max(10)
      .refine(hasAtMostOneDecimalPlace, "Scores may use at most one decimal place."),
    rationale: z.string().trim().min(1).max(2_000)
  })
  .strict();

const criticalErrorSchema = z.discriminatedUnion("present", [
  z
    .object({
      present: z.literal(false),
      categories: z.array(z.never()).length(0),
      evidence: z.null()
    })
    .strict(),
  z
    .object({
      present: z.literal(true),
      categories: z
        .array(z.string().trim().min(1).max(200))
        .min(1)
        .refine((categories) => new Set(categories).size === categories.length, {
          message: "Critical-error categories must be unique."
        }),
      evidence: z.string().trim().min(1).max(2_000)
    })
    .strict()
]);

const dimensionsSchema = z
  .object({
    correctness: dimensionScoreSchema,
    taskFulfillment: dimensionScoreSchema,
    evidenceQuality: dimensionScoreSchema,
    reasoningRigor: dimensionScoreSchema,
    critiqueQuality: dimensionScoreSchema,
    synthesisImprovement: dimensionScoreSchema,
    clarityActionability: dimensionScoreSchema
  })
  .strict();

const dimensionWeights = {
  correctness: 30,
  taskFulfillment: 15,
  evidenceQuality: 15,
  reasoningRigor: 15,
  critiqueQuality: 10,
  synthesisImprovement: 10,
  clarityActionability: 5
} as const;

const evaluatorCandidateScoreFields = {
  candidateId: blindCandidateIdSchema,
  dimensions: dimensionsSchema,
  criticalError: criticalErrorSchema
};

const evaluatorCandidateScoreSchema = z.object(evaluatorCandidateScoreFields).strict();

function candidateSetIssues(
  candidates: readonly { candidateId: string }[],
  expectedCandidateIds: readonly string[],
  context: z.RefinementCtx
): void {
  const expected = new Set(expectedCandidateIds);
  const actual = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (actual.has(candidate.candidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "candidateId"],
        message: `Duplicate candidate ID: ${candidate.candidateId}.`
      });
    }
    actual.add(candidate.candidateId);
    if (!expected.has(candidate.candidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "candidateId"],
        message: `Unexpected candidate ID: ${candidate.candidateId}.`
      });
    }
  }
  for (const candidateId of expected) {
    if (!actual.has(candidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: `Missing candidate ID: ${candidateId}.`
      });
    }
  }
}

function canonicalCandidateSetIssues(
  candidateIds: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[]
): void {
  const expected = BLIND_CANDIDATE_IDS.slice(0, candidateIds.length);
  if (!candidateIdsAreCanonical(candidateIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Candidate IDs must be exactly ${expected.join(", ")}.`
    });
  }
}

function candidateIdsAreCanonical(candidateIds: readonly string[]): boolean {
  const expected = BLIND_CANDIDATE_IDS.slice(0, candidateIds.length);
  return (
    candidateIds.length >= 2 &&
    candidateIds.length <= 3 &&
    new Set(candidateIds).size === candidateIds.length &&
    candidateIds.every((candidateId) => expected.includes(candidateId as never))
  );
}

export function evaluatorOutputForCandidatesSchema(
  expectedCandidateIds: readonly string[]
): z.ZodType<EvaluatorOutput> {
  if (!candidateIdsAreCanonical(expectedCandidateIds)) {
    throw new Error(
      "Blind evaluation requires the canonical Candidate A/B or Candidate A/B/C set."
    );
  }
  return z
    .object({
      schemaVersion: z.literal(1),
      candidates: z.array(evaluatorCandidateScoreSchema).min(2).max(3)
    })
    .strict()
    .superRefine((value, context) =>
      candidateSetIssues(value.candidates, expectedCandidateIds, context)
    );
}

const totalScoreSchema = z
  .number()
  .finite()
  .min(0)
  .max(100)
  .refine(hasAtMostOneDecimalPlace, "Totals may use at most one decimal place.");

const blindCandidateScoreSchema = z
  .object({
    ...evaluatorCandidateScoreFields,
    rawTotal: totalScoreSchema,
    capApplied: z.boolean(),
    finalScore: totalScoreSchema
  })
  .strict()
  .superRefine(validateComputedScore);

function validateComputedScore(
  candidate: {
    rawTotal: number;
    capApplied: boolean;
    finalScore: number;
    criticalError: { present: boolean };
    dimensions: z.infer<typeof dimensionsSchema>;
  },
  context: z.RefinementCtx
): void {
  const weightedTenths = Object.entries(dimensionWeights).reduce(
    (total, [dimension, weight]) =>
      total +
      Math.round(candidate.dimensions[dimension as keyof typeof dimensionWeights].score * 10) *
        weight,
    0
  );
  const expectedRaw = Math.round(weightedTenths / 10) / 10;
  if (candidate.rawTotal !== expectedRaw) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rawTotal"],
      message: "Raw total does not match the dimension scores and weights."
    });
  }
  const expectedFinal = candidate.criticalError.present ? Math.min(expectedRaw, 59) : expectedRaw;
  if (candidate.finalScore !== expectedFinal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["finalScore"],
      message: "Final score does not match the critical-error cap."
    });
  }
  if (candidate.capApplied !== (expectedFinal !== candidate.rawTotal)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capApplied"],
      message: "capApplied does not match the calculated final score."
    });
  }
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 digest.");

export const blindEvaluationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluator: providerIdSchema,
    candidateIds: z.array(blindCandidateIdSchema).min(2).max(3),
    inputSha256: sha256Schema,
    scoresLockedAt: z.string().datetime(),
    candidates: z.array(blindCandidateScoreSchema).min(2).max(3)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.candidateIds).size !== value.candidateIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateIds"],
        message: "Candidate IDs must be unique."
      });
    }
    canonicalCandidateSetIssues(value.candidateIds, context, ["candidateIds"]);
    candidateSetIssues(value.candidates, value.candidateIds, context);
  });

const durationSchema = z.number().int().nonnegative().nullable();
const providerStageDurationsSchema = z
  .object({
    initialMs: durationSchema,
    reviewMs: durationSchema,
    finalMs: durationSchema,
    totalMs: durationSchema
  })
  .strict()
  .superRefine((value, context) => {
    const stages = [value.initialMs, value.reviewMs, value.finalMs];
    const expectedTotal = stages.every((duration): duration is number => duration !== null)
      ? stages.reduce((total, duration) => total + duration, 0)
      : null;
    if (value.totalMs !== expectedTotal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalMs"],
        message: "Total duration must equal the three stage durations."
      });
    }
  });

const resolvedCandidateScoreSchema = z
  .object({
    ...evaluatorCandidateScoreFields,
    rawTotal: totalScoreSchema,
    capApplied: z.boolean(),
    finalScore: totalScoreSchema,
    provider: providerIdSchema,
    relationship: z.enum(["self", "peer"])
  })
  .strict()
  .superRefine(validateComputedScore);

export const resolvedEvaluationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluator: providerIdSchema,
    sessionId: z.string().uuid(),
    runId: z.string().min(1),
    status: z.literal("completed"),
    model: z.string().trim().min(1).max(200).nullable(),
    effort: z.string().trim().min(1).max(100).nullable(),
    blindness: z
      .object({
        bestEffort: z.literal(true),
        freshSession: z.literal(true),
        isolatedWorkingDirectory: z.literal(true),
        timingWithheld: z.literal(true),
        identitiesRevealedAfterLock: z.literal(true)
      })
      .strict(),
    mapping: z
      .array(z.object({ candidateId: blindCandidateIdSchema, provider: providerIdSchema }).strict())
      .min(2)
      .max(3),
    candidates: z.array(resolvedCandidateScoreSchema).min(2).max(3),
    blindResultSha256: sha256Schema,
    durations: z
      .object({
        codex: providerStageDurationsSchema,
        claude: providerStageDurationsSchema,
        copilot: providerStageDurationsSchema
      })
      .strict(),
    scoresLockedAt: z.string().datetime(),
    identitiesRevealedAt: z.string().datetime(),
    warnings: z.array(z.string().trim().min(1).max(2_000))
  })
  .strict()
  .superRefine((value, context) => {
    const candidateIds = value.mapping.map(({ candidateId }) => candidateId);
    const providers = value.mapping.map(({ provider }) => provider);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mapping"],
        message: "Candidate mapping contains a duplicate Candidate ID."
      });
    }
    canonicalCandidateSetIssues(candidateIds, context, ["mapping"]);
    if (new Set(providers).size !== providers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mapping"],
        message: "Candidate mapping contains a duplicate provider."
      });
    }
    candidateSetIssues(value.candidates, candidateIds, context);
    const providerByCandidate = new Map(
      value.mapping.map(({ candidateId, provider }) => [candidateId, provider])
    );
    const mappedProviders = new Set(providers);
    for (const [index, candidate] of value.candidates.entries()) {
      if (providerByCandidate.get(candidate.candidateId) !== candidate.provider) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "provider"],
          message: "Resolved candidate provider does not match the mapping."
        });
      }
      const expectedRelationship = candidate.provider === value.evaluator ? "self" : "peer";
      if (candidate.relationship !== expectedRelationship) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "relationship"],
          message: "Candidate relationship does not match the evaluator."
        });
      }
    }
    for (const provider of ["codex", "claude", "copilot"] as const) {
      const duration = value.durations[provider];
      if (!mappedProviders.has(provider)) {
        const hasUnexpectedTiming =
          duration.initialMs !== null ||
          duration.reviewMs !== null ||
          duration.finalMs !== null ||
          duration.totalMs !== null;
        if (hasUnexpectedTiming) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["durations", provider],
            message: "A non-candidate provider cannot have original-run timing."
          });
        }
      }
    }
    if (Date.parse(value.identitiesRevealedAt) < Date.parse(value.scoresLockedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identitiesRevealedAt"],
        message: "Candidate identities cannot be revealed before scores are locked."
      });
    }
  });
