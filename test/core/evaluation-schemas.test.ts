import { describe, expect, it } from "vitest";
import {
  blindEvaluationResultSchema,
  evaluatorOutputForCandidatesSchema,
  resolvedEvaluationResultSchema
} from "../../src/core/evaluation-schemas.js";

function dimensions(score = 8) {
  return {
    correctness: { score, rationale: "Correctness rationale." },
    taskFulfillment: { score, rationale: "Task-fulfillment rationale." },
    evidenceQuality: { score, rationale: "Evidence-quality rationale." },
    reasoningRigor: { score, rationale: "Reasoning-rigor rationale." },
    critiqueQuality: { score, rationale: "Critique-quality rationale." },
    synthesisImprovement: { score, rationale: "Synthesis rationale." },
    clarityActionability: { score, rationale: "Clarity rationale." }
  };
}

function candidate(candidateId: string, score = 8) {
  return {
    candidateId,
    dimensions: dimensions(score),
    criticalError: { present: false as const, categories: [], evidence: null }
  };
}

function validOutput() {
  return {
    schemaVersion: 1,
    candidates: [candidate("Candidate A"), candidate("Candidate B")]
  };
}

function firstCandidate(output: ReturnType<typeof validOutput>) {
  const first = output.candidates[0];
  if (first === undefined) throw new Error("Test fixture has no first candidate.");
  return first;
}

function secondCandidate(output: ReturnType<typeof validOutput>) {
  const second = output.candidates[1];
  if (second === undefined) throw new Error("Test fixture has no second candidate.");
  return second;
}

describe("blind evaluator output schema", () => {
  const schema = evaluatorOutputForCandidatesSchema(["Candidate A", "Candidate B"]);

  it("accepts exactly the supplied candidates and all seven dimensions", () => {
    expect(schema.safeParse(validOutput()).success).toBe(true);
  });

  it("rejects a noncanonical expected Candidate set", () => {
    expect(() => evaluatorOutputForCandidatesSchema(["Candidate A", "Candidate C"])).toThrowError(
      "canonical Candidate A/B"
    );
  });

  it("rejects model-supplied totals, ranks, and unknown dimensions", () => {
    const withTotal = validOutput();
    Object.assign(firstCandidate(withTotal), { total: 80, rank: 1 });
    expect(schema.safeParse(withTotal).success).toBe(false);

    const withDimension = validOutput();
    Object.assign(firstCandidate(withDimension).dimensions, {
      speed: { score: 10, rationale: "Fast." }
    });
    expect(schema.safeParse(withDimension).success).toBe(false);
  });

  it("rejects missing, duplicate, and unexpected Candidate IDs", () => {
    const duplicate = validOutput();
    secondCandidate(duplicate).candidateId = "Candidate A";
    expect(schema.safeParse(duplicate).success).toBe(false);

    const unexpected = validOutput();
    secondCandidate(unexpected).candidateId = "Candidate C";
    expect(schema.safeParse(unexpected).success).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 10.1, 8.25])(
    "rejects an invalid dimension score %s",
    (score) => {
      const output = validOutput();
      firstCandidate(output).dimensions.correctness.score = score;
      expect(schema.safeParse(output).success).toBe(false);
    }
  );

  it("requires every dimension and a non-empty rationale", () => {
    const missing = validOutput();
    delete (
      firstCandidate(missing).dimensions as Partial<
        (typeof missing.candidates)[number]["dimensions"]
      >
    ).critiqueQuality;
    expect(schema.safeParse(missing).success).toBe(false);

    const blank = validOutput();
    firstCandidate(blank).dimensions.correctness.rationale = "   ";
    expect(schema.safeParse(blank).success).toBe(false);
  });

  it("enforces critical-error evidence consistency", () => {
    const missingEvidence = validOutput();
    firstCandidate(missingEvidence).criticalError = {
      present: true,
      categories: [],
      evidence: null
    } as never;
    expect(schema.safeParse(missingEvidence).success).toBe(false);

    const falseWithEvidence = validOutput();
    firstCandidate(falseWithEvidence).criticalError = {
      present: false,
      categories: ["fabrication"],
      evidence: "Unsupported citation."
    } as never;
    expect(schema.safeParse(falseWithEvidence).success).toBe(false);
  });
});

describe("persisted evaluation Candidate IDs", () => {
  it("rejects a noncanonical two-candidate A/C set", () => {
    const scored = (candidateId: "Candidate A" | "Candidate C") => ({
      ...candidate(candidateId),
      rawTotal: 80,
      capApplied: false,
      finalScore: 80
    });
    const blind = {
      schemaVersion: 1,
      evaluator: "codex",
      candidateIds: ["Candidate A", "Candidate C"],
      inputSha256: "a".repeat(64),
      scoresLockedAt: "2026-08-25T00:00:00.000Z",
      candidates: [scored("Candidate A"), scored("Candidate C")]
    };
    expect(blindEvaluationResultSchema.safeParse(blind).success).toBe(false);

    const missing = { initialMs: null, reviewMs: null, finalMs: null, totalMs: null };
    expect(
      resolvedEvaluationResultSchema.safeParse({
        schemaVersion: 1,
        evaluator: "codex",
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
        runId: "run-1",
        status: "completed",
        model: null,
        effort: null,
        blindness: {
          bestEffort: true,
          freshSession: true,
          isolatedWorkingDirectory: true,
          timingWithheld: true,
          identitiesRevealedAfterLock: true
        },
        mapping: [
          { candidateId: "Candidate A", provider: "codex" },
          { candidateId: "Candidate C", provider: "claude" }
        ],
        candidates: [
          { ...scored("Candidate A"), provider: "codex", relationship: "self" },
          { ...scored("Candidate C"), provider: "claude", relationship: "peer" }
        ],
        blindResultSha256: "b".repeat(64),
        durations: { codex: missing, claude: missing, copilot: missing },
        scoresLockedAt: "2026-08-25T00:00:00.000Z",
        identitiesRevealedAt: "2026-08-25T00:00:00.000Z",
        warnings: []
      }).success
    ).toBe(false);
  });
});
