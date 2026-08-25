import type { ProviderId } from "./types.js";

export const EVALUATION_DIMENSION_IDS = [
  "correctness",
  "taskFulfillment",
  "evidenceQuality",
  "reasoningRigor",
  "critiqueQuality",
  "synthesisImprovement",
  "clarityActionability"
] as const;

export type EvaluationDimensionId = (typeof EVALUATION_DIMENSION_IDS)[number];

export const BLIND_CANDIDATE_IDS = ["Candidate A", "Candidate B", "Candidate C"] as const;
export type BlindCandidateId = (typeof BLIND_CANDIDATE_IDS)[number];

export type EvaluationDimensionScore = {
  score: number;
  rationale: string;
};

export type CriticalErrorJudgment = {
  present: boolean;
  categories: string[];
  evidence: string | null;
};

export type EvaluatorCandidateOutput = {
  candidateId: BlindCandidateId;
  dimensions: Record<EvaluationDimensionId, EvaluationDimensionScore>;
  criticalError: CriticalErrorJudgment;
};

export type EvaluatorOutput = {
  schemaVersion: 1;
  candidates: EvaluatorCandidateOutput[];
};

export type BlindCandidateScore = EvaluatorCandidateOutput & {
  rawTotal: number;
  capApplied: boolean;
  finalScore: number;
};

export type BlindEvaluationResult = {
  schemaVersion: 1;
  evaluator: ProviderId;
  candidateIds: BlindCandidateId[];
  inputSha256: string;
  scoresLockedAt: string;
  candidates: BlindCandidateScore[];
};

export type CandidateRelationship = "self" | "peer";

export type ResolvedCandidateScore = BlindCandidateScore & {
  provider: ProviderId;
  relationship: CandidateRelationship;
};

export type ProviderStageDurations = {
  initialMs: number | null;
  reviewMs: number | null;
  finalMs: number | null;
  totalMs: number | null;
};

export type EvaluationBlindness = {
  bestEffort: true;
  freshSession: true;
  isolatedWorkingDirectory: true;
  timingWithheld: true;
  identitiesRevealedAfterLock: true;
};

export type ResolvedEvaluationResult = {
  schemaVersion: 1;
  evaluator: ProviderId;
  sessionId: string;
  runId: string;
  status: "completed";
  model: string | null;
  effort: string | null;
  blindness: EvaluationBlindness;
  mapping: { candidateId: BlindCandidateId; provider: ProviderId }[];
  candidates: ResolvedCandidateScore[];
  blindResultSha256: string;
  durations: Record<ProviderId, ProviderStageDurations>;
  scoresLockedAt: string;
  identitiesRevealedAt: string;
  warnings: string[];
};

export type RankedCandidate<T extends { finalScore: number }> = T & { rank: number };

export type PeerScoreSummary = {
  provider: ProviderId;
  selfScore: number | null;
  peerAverage: number | null;
  selfPeerGap: number | null;
  peerRank: number | null;
  peerRatingCount: number;
};
