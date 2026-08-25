import { describe, expect, it } from "vitest";
import type { ResolvedEvaluationResult } from "../../src/core/evaluation-types.js";
import { renderBlindEvaluation, renderPeerScoreSummary } from "../../src/ui/evaluation.js";

function dimensions() {
  const dimension = { score: 8, rationale: "Specific rationale." };
  return {
    correctness: dimension,
    taskFulfillment: dimension,
    evidenceQuality: dimension,
    reasoningRigor: dimension,
    critiqueQuality: dimension,
    synthesisImprovement: dimension,
    clarityActionability: dimension
  };
}

function result(): ResolvedEvaluationResult {
  const missing = { initialMs: null, reviewMs: null, finalMs: null, totalMs: null };
  return {
    schemaVersion: 1,
    evaluator: "codex",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    runId: "2026-08-25T00-00-00-000Z",
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
      { candidateId: "Candidate A", provider: "claude" },
      { candidateId: "Candidate B", provider: "codex" }
    ],
    candidates: [
      {
        candidateId: "Candidate A",
        dimensions: dimensions(),
        criticalError: { present: false, categories: [], evidence: null },
        rawTotal: 80,
        capApplied: false,
        finalScore: 80,
        provider: "claude",
        relationship: "peer"
      },
      {
        candidateId: "Candidate B",
        dimensions: dimensions(),
        criticalError: { present: false, categories: [], evidence: null },
        rawTotal: 80,
        capApplied: false,
        finalScore: 80,
        provider: "codex",
        relationship: "self"
      }
    ],
    blindResultSha256: "a".repeat(64),
    durations: {
      codex: { initialMs: 1_000, reviewMs: 2_000, finalMs: 3_000, totalMs: 6_000 },
      claude: missing,
      copilot: missing
    },
    scoresLockedAt: "2026-08-25T00:00:00.000Z",
    identitiesRevealedAt: "2026-08-25T00:00:01.000Z",
    warnings: []
  };
}

describe("blind evaluation rendering", () => {
  it.each([120, 50])(
    "preserves provenance, reveal order, and timing disclaimer at width %i",
    (width) => {
      const output = renderBlindEvaluation(result(), "a long session label for wrapping", width);
      expect(output).toContain("Blind Evaluation by Codex");
      expect(output).toContain("Evaluator          CODEX · visible");
      expect(output).toContain("Scores Assigned by CODEX");
      expect(output.indexOf("✓ Scores locked")).toBeLessThan(output.indexOf("Identity Mapping"));
      expect(output).toContain("Candidate A");
      expect(output).toContain("Claude");
      expect(output).toContain("Peer");
      expect(output).toContain("not included in score");
      expect(output).toContain("Stage 1 Initial");
      expect(output).toContain("Stage 2 Cross-Review");
      expect(output).toContain("Stage 3 Final Report");
    }
  );

  it("uses only the two participating providers and omits forbidden sections", () => {
    const output = renderBlindEvaluation(result(), "session", 120);
    expect(output).not.toContain("Copilot");
    expect(output).not.toMatch(/^Strengths/imu);
    expect(output).not.toMatch(/^Weaknesses/imu);
    expect(output).not.toMatch(/^Recommendation/imu);
    expect(output).not.toMatch(/\bwinner\b/iu);
  });

  it("stacks candidate scores and timings instead of wrapping tables on narrow terminals", () => {
    const output = renderBlindEvaluation(result(), "session", 50);
    expect(output).toContain("Candidate A · Claude · Peer");
    expect(output).toContain("Rank            1");
    expect(output).toContain("Correctness (30%)  8.0");
    expect(output).toContain("Stage 2 Cross-Review  2s");
    expect(output).not.toContain("Rank | Blind ID");
    expect(output).not.toContain("Correctness (30%) |");
    expect(Math.max(...output.split("\n").map((line) => line.length))).toBeLessThanOrEqual(50);
  });

  it("labels partial peer summaries incomplete and shows rating counts", () => {
    const output = renderPeerScoreSummary(
      [
        {
          provider: "codex",
          selfScore: 80,
          peerAverage: 75,
          selfPeerGap: 5,
          peerRank: 1,
          peerRatingCount: 1
        }
      ],
      false
    );
    expect(output).toContain("Incomplete evaluator set; this is not consensus.");
    expect(output).toContain("Peer Ratings");
    expect(output).toContain("No blended Council score");
  });
});
