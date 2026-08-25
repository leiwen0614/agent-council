import { describe, expect, it } from "vitest";
import {
  aggregatePeerScores,
  calculateProviderDurations,
  rankCandidates,
  scoreEvaluatorOutput
} from "../../src/core/evaluation-scoring.js";
import type {
  BlindCandidateId,
  EvaluatorCandidateOutput,
  ResolvedEvaluationResult
} from "../../src/core/evaluation-types.js";
import type { CouncilRun, ProviderId, ProviderStageState, Stage } from "../../src/core/types.js";

const timestamp = "2026-08-25T00:00:00.000Z";

function candidate(
  candidateId: BlindCandidateId,
  score: number,
  criticalError = false
): EvaluatorCandidateOutput {
  const dimension = { score, rationale: "Evidence-based rationale." };
  return {
    candidateId,
    dimensions: {
      correctness: dimension,
      taskFulfillment: dimension,
      evidenceQuality: dimension,
      reasoningRigor: dimension,
      critiqueQuality: dimension,
      synthesisImprovement: dimension,
      clarityActionability: dimension
    },
    criticalError: criticalError
      ? { present: true, categories: ["central conclusion"], evidence: "Material error." }
      : { present: false, categories: [], evidence: null }
  };
}

describe("blind evaluation scoring", () => {
  it("computes weighted totals in integer tenths and applies critical-error caps afterward", () => {
    const detailed = candidate("Candidate A", 0);
    detailed.dimensions = {
      correctness: { score: 9, rationale: "r" },
      taskFulfillment: { score: 8.5, rationale: "r" },
      evidenceQuality: { score: 8, rationale: "r" },
      reasoningRigor: { score: 7.5, rationale: "r" },
      critiqueQuality: { score: 7, rationale: "r" },
      synthesisImprovement: { score: 6.5, rationale: "r" },
      clarityActionability: { score: 6, rationale: "r" }
    };
    const capped = candidate("Candidate B", 9, true);
    const belowCap = candidate("Candidate C", 5, true);

    expect(
      scoreEvaluatorOutput({ schemaVersion: 1, candidates: [detailed, capped, belowCap] }).map(
        ({ rawTotal, capApplied, finalScore }) => ({ rawTotal, capApplied, finalScore })
      )
    ).toEqual([
      { rawTotal: 79.5, capApplied: false, finalScore: 79.5 },
      { rawTotal: 90, capApplied: true, finalScore: 59 },
      { rawTotal: 50, capApplied: false, finalScore: 50 }
    ]);
  });

  it("assigns competition ranks and shares equal ranks", () => {
    expect(
      rankCandidates([
        { provider: "copilot" as const, finalScore: 80 },
        { provider: "claude" as const, finalScore: 90 },
        { provider: "codex" as const, finalScore: 90 }
      ]).map(({ provider, rank }) => [provider, rank])
    ).toEqual([
      ["claude", 1],
      ["codex", 1],
      ["copilot", 3]
    ]);
  });
});

function providerState(
  stage: Stage,
  attempts: { number: number; startedAt: string; finishedAt: string }[]
): ProviderStageState {
  return {
    status: attempts.length === 0 ? "skipped" : "completed",
    artifact: `${stage}.md`,
    attempts: attempts.map((attempt) => ({ ...attempt, status: "completed" }))
  };
}

function runForTiming(): CouncilRun {
  const firstStart = "2026-08-25T00:00:00.000Z";
  const firstEnd = "2026-08-25T00:00:01.000Z";
  const retryStart = "2026-08-25T00:01:00.000Z";
  const retryEnd = "2026-08-25T00:01:02.500Z";
  const one = [{ number: 1, startedAt: firstStart, finishedAt: firstEnd }];
  const two = [
    { number: 1, startedAt: firstStart, finishedAt: firstEnd },
    { number: 2, startedAt: retryStart, finishedAt: retryEnd }
  ];
  const stage = (name: Stage, codexAttempts = one) => ({
    status: "completed" as const,
    startedAt: firstStart,
    finishedAt: retryEnd,
    providers: {
      codex: providerState(name, codexAttempts),
      claude: providerState(name, one),
      copilot: providerState(name, [])
    }
  });
  return {
    schemaVersion: 1,
    id: "run",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    status: "awaiting_decision",
    createdAt: timestamp,
    updatedAt: timestamp,
    eventSequence: 0,
    degraded: false,
    effectiveConfig: {
      enabledProviders: ["codex", "claude"],
      agents: {
        codex: { yolo: false, model: null, effort: null },
        claude: { yolo: false, model: null, effort: null },
        copilot: { yolo: false, model: null, effort: null }
      }
    },
    stages: { initial: stage("initial", two), review: stage("review"), final: stage("final") },
    reviewMappings: {},
    degradedContinuations: []
  };
}

describe("original-run timing", () => {
  it("sums attempt execution only, including retries, and preserves missing legacy timing", () => {
    const durations = calculateProviderDurations(runForTiming());
    expect(durations.codex).toEqual({
      initialMs: 3_500,
      reviewMs: 1_000,
      finalMs: 1_000,
      totalMs: 5_500
    });
    expect(durations.copilot).toEqual({
      initialMs: null,
      reviewMs: null,
      finalMs: null,
      totalMs: null
    });
  });
});

function resolvedEvaluation(
  evaluator: ProviderId,
  scores: Record<ProviderId, number>
): ResolvedEvaluationResult {
  const providers: ProviderId[] = ["codex", "claude", "copilot"];
  const ids: BlindCandidateId[] = ["Candidate A", "Candidate B", "Candidate C"];
  const candidates = providers.map((provider, index) => {
    const candidateId = ids[index];
    if (candidateId === undefined) throw new Error("Missing Candidate ID.");
    const base = candidate(candidateId, scores[provider]);
    return {
      ...base,
      rawTotal: scores[provider],
      capApplied: false,
      finalScore: scores[provider],
      provider,
      relationship: provider === evaluator ? ("self" as const) : ("peer" as const)
    };
  });
  const empty = { initialMs: null, reviewMs: null, finalMs: null, totalMs: null };
  return {
    schemaVersion: 1,
    evaluator,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    runId: "run",
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
    mapping: providers.map((provider, index) => {
      const candidateId = ids[index];
      if (candidateId === undefined) throw new Error("Missing Candidate ID.");
      return { candidateId, provider };
    }),
    candidates,
    blindResultSha256: "a".repeat(64),
    durations: { codex: empty, claude: empty, copilot: empty },
    scoresLockedAt: timestamp,
    identitiesRevealedAt: timestamp,
    warnings: []
  };
}

describe("peer-only aggregation", () => {
  it("excludes self scores and reports rating counts, gaps, and tied competition ranks", () => {
    const results = aggregatePeerScores(
      [
        resolvedEvaluation("codex", { codex: 90, claude: 80, copilot: 70 }),
        resolvedEvaluation("claude", { codex: 80, claude: 70, copilot: 70 }),
        resolvedEvaluation("copilot", { codex: 80, claude: 80, copilot: 60 })
      ],
      ["codex", "claude", "copilot"]
    );

    expect(results).toEqual([
      {
        provider: "codex",
        selfScore: 90,
        peerAverage: 80,
        selfPeerGap: 10,
        peerRank: 1,
        peerRatingCount: 2
      },
      {
        provider: "claude",
        selfScore: 70,
        peerAverage: 80,
        selfPeerGap: -10,
        peerRank: 1,
        peerRatingCount: 2
      },
      {
        provider: "copilot",
        selfScore: 60,
        peerAverage: 70,
        selfPeerGap: -10,
        peerRank: 3,
        peerRatingCount: 2
      }
    ]);
  });
});
