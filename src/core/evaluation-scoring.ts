import { PROVIDERS, STAGES, type CouncilRun, type ProviderId, type Stage } from "./types.js";
import { EVALUATION_DIMENSION_IDS } from "./evaluation-types.js";
import type {
  BlindCandidateScore,
  EvaluatorOutput,
  PeerScoreSummary,
  ProviderStageDurations,
  RankedCandidate,
  ResolvedEvaluationResult
} from "./evaluation-types.js";

export const EVALUATION_WEIGHTS = {
  correctness: 30,
  taskFulfillment: 15,
  evidenceQuality: 15,
  reasoningRigor: 15,
  critiqueQuality: 10,
  synthesisImprovement: 10,
  clarityActionability: 5
} as const;

export const CRITICAL_ERROR_SCORE_CAP = 59;

const weightTotal = Object.values(EVALUATION_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
if (weightTotal !== 100) throw new Error("Blind-evaluation weights must total exactly 100.");

function toTenths(value: number): number {
  return Math.round(value * 10);
}

function fromTenths(value: number): number {
  return value / 10;
}

export function scoreEvaluatorOutput(output: EvaluatorOutput): BlindCandidateScore[] {
  return output.candidates.map((candidate) => {
    const weightedTenths = EVALUATION_DIMENSION_IDS.reduce(
      (sum, dimension) =>
        sum + toTenths(candidate.dimensions[dimension].score) * EVALUATION_WEIGHTS[dimension],
      0
    );
    const rawTotal = fromTenths(Math.round(weightedTenths / 10));
    const capApplied = candidate.criticalError.present && rawTotal > CRITICAL_ERROR_SCORE_CAP;
    return {
      ...candidate,
      rawTotal,
      capApplied,
      finalScore: capApplied ? CRITICAL_ERROR_SCORE_CAP : rawTotal
    };
  });
}

export function rankCandidates<T extends { finalScore: number; provider?: ProviderId }>(
  candidates: readonly T[]
): RankedCandidate<T>[] {
  const sorted = [...candidates].sort(
    (left, right) =>
      right.finalScore - left.finalScore ||
      (left.provider ?? "").localeCompare(right.provider ?? "")
  );
  let previousScore: number | null = null;
  let previousRank = 0;
  return sorted.map((candidate, index) => {
    const rank = previousScore === candidate.finalScore ? previousRank : index + 1;
    previousScore = candidate.finalScore;
    previousRank = rank;
    return { ...candidate, rank };
  });
}

function stageDuration(run: CouncilRun, provider: ProviderId, stage: Stage): number | null {
  const attempts = run.stages[stage].providers[provider].attempts;
  if (attempts.length === 0) return null;
  return attempts.reduce((total, attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    const finishedAt = Date.parse(attempt.finishedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
      throw new Error(
        `Invalid persisted timing for ${provider} ${stage} attempt ${String(attempt.number)}.`
      );
    }
    return total + Math.max(0, finishedAt - startedAt);
  }, 0);
}

export function calculateProviderDurations(
  run: CouncilRun
): Record<ProviderId, ProviderStageDurations> {
  return Object.fromEntries(
    PROVIDERS.map((provider) => {
      const stageDurations = Object.fromEntries(
        STAGES.map((stage) => [stage, stageDuration(run, provider, stage)])
      ) as Record<Stage, number | null>;
      const values = STAGES.map((stage) => stageDurations[stage]);
      const totalMs = values.every((duration) => duration !== null)
        ? values.reduce((sum, duration) => sum + duration, 0)
        : null;
      return [
        provider,
        {
          initialMs: stageDurations.initial,
          reviewMs: stageDurations.review,
          finalMs: stageDurations.final,
          totalMs
        }
      ];
    })
  ) as Record<ProviderId, ProviderStageDurations>;
}

export function aggregatePeerScores(
  evaluations: readonly ResolvedEvaluationResult[],
  targetProviders: readonly ProviderId[]
): PeerScoreSummary[] {
  if (new Set(evaluations.map((evaluation) => evaluation.evaluator)).size !== evaluations.length) {
    throw new Error("Only one completed result per evaluator can be aggregated.");
  }
  if (new Set(targetProviders).size !== targetProviders.length) {
    throw new Error("Target providers must be unique.");
  }

  const summaries: PeerScoreSummary[] = targetProviders.map((provider) => {
    let selfScore: number | null = null;
    const peerScores: number[] = [];
    for (const evaluation of evaluations) {
      const score = evaluation.candidates.find((candidate) => candidate.provider === provider);
      if (score === undefined) continue;
      if (evaluation.evaluator === provider) selfScore = score.finalScore;
      else peerScores.push(score.finalScore);
    }
    const peerAverageTenths =
      peerScores.length === 0
        ? null
        : Math.round(
            peerScores.reduce((sum, score) => sum + toTenths(score), 0) / peerScores.length
          );
    const peerAverage = peerAverageTenths === null ? null : fromTenths(peerAverageTenths);
    return {
      provider,
      selfScore,
      peerAverage,
      selfPeerGap:
        selfScore === null || peerAverageTenths === null
          ? null
          : fromTenths(toTenths(selfScore) - peerAverageTenths),
      peerRank: null,
      peerRatingCount: peerScores.length
    };
  });

  const ranked = summaries
    .filter(
      (summary): summary is PeerScoreSummary & { peerAverage: number } =>
        summary.peerAverage !== null
    )
    .sort(
      (left, right) =>
        right.peerAverage - left.peerAverage || left.provider.localeCompare(right.provider)
    );
  let previousAverage: number | null = null;
  let previousRank = 0;
  ranked.forEach((summary, index) => {
    const rank = previousAverage === summary.peerAverage ? previousRank : index + 1;
    const target = summaries.find((candidate) => candidate.provider === summary.provider);
    if (target === undefined) {
      throw new Error(`No peer-score summary exists for ${summary.provider}.`);
    }
    target.peerRank = rank;
    previousAverage = summary.peerAverage;
    previousRank = rank;
  });
  return summaries;
}
