import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import type { ResolvedEvaluationResult } from "../../src/core/evaluation-types.js";
import {
  renderBlindEvaluation,
  renderEvaluationFailures,
  renderEvaluationTiming,
  renderPeerScoreSummary
} from "../../src/ui/evaluation.js";

function expectClosedGrids(output: string, width: number): string[] {
  const sections = output.split("\n\n");
  expect(sections.length).toBeGreaterThan(0);
  for (const section of sections) {
    const lines = section.split("\n");
    expect(lines[0]).toMatch(/^┌─+┐$/u);
    expect(lines.at(-1)).toMatch(/^└[─┴]+┘$/u);
    expect(lines.every((line) => stringWidth(line) === width)).toBe(true);
    expect(
      lines.slice(1, -1).every((line) => {
        if (line.startsWith("│")) return line.endsWith("│");
        return line.startsWith("├") && line.endsWith("┤");
      })
    ).toBe(true);
  }
  return sections;
}

function expectValueCell(output: string, value: string): void {
  expect(output.split("\n").some((line) => line.startsWith("│") && line.includes(value))).toBe(
    true
  );
}

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
    "renders every section as a closed grid and preserves required content at width %i",
    (width) => {
      const output = renderBlindEvaluation(result(), "a long session label for wrapping", width);
      const sections = expectClosedGrids(output, width);

      expect(sections.length).toBe(width >= 100 ? 5 : 8);
      expect(output).toContain("Blind Evaluation by Codex");
      expect(output).toContain("Scores Assigned by CODEX");
      expect(output.indexOf("✓ Scores locked")).toBeLessThan(output.indexOf("Scores Assigned"));
      expect(output).not.toContain("Identity Mapping");
      const metadata = sections[0] ?? "";
      expect(metadata).toContain("Candidates & Mapping");
      expect(metadata).toContain("Anonymous during");
      expect(metadata).toContain("scoring · randomized");
      expect(metadata).toContain("for this evaluator");
      expect(metadata).toContain("Evaluation Status");
      expect(metadata).toContain("Blind scores");
      expect(metadata).toContain("validated · ✓ Scores");
      expect(metadata).toContain("locked · ✓ Candidate");
      expect(metadata).toContain("identities revealed");
      expect(metadata).not.toMatch(/│ Run\s*│/u);
      expect(metadata).not.toMatch(/│ Evaluator\s*│/u);
      expect(metadata).not.toMatch(/│ Execution Time\s*│/u);
      expectValueCell(output, "Candidate A");
      expectValueCell(output, "Claude");
      expectValueCell(output, "Peer");
      expect(output).toContain("not included in score");
      expectValueCell(output, "Stage 1 Initial");
      expectValueCell(output, "Stage 2 Cross-Review");
      expectValueCell(output, "Stage 3 Final Report");
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

  it("stacks candidates into separate grids on narrow terminals", () => {
    const output = renderBlindEvaluation(result(), "session", 50);
    const sections = expectClosedGrids(output, 50);

    expect(
      sections.filter((section) => section.includes("│ Scores Assigned by CODEX ·"))
    ).toHaveLength(2);
    expect(
      sections.filter((section) => section.includes("Dimension Scores Assigned by CODEX ·"))
    ).toHaveLength(2);
    expect(sections.filter((section) => section.includes("not included in score ·"))).toHaveLength(
      2
    );
    expectValueCell(output, "Correctness");
    expectValueCell(output, "30%");
    expectValueCell(output, "8.0");
    expectValueCell(output, "2s");
  });

  it.each([120, 50])("renders peer-summary metadata and scores as grids at width %i", (width) => {
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
      false,
      width
    );
    const sections = expectClosedGrids(output, width);

    expect(sections).toHaveLength(2);
    expect(output).toContain("Incomplete evaluator set; this");
    expect(output).toContain("is not consensus.");
    expectValueCell(output, "Peer Ratings");
    expectValueCell(output, "1");
    expect(output).toContain("No blended");
    expect(output).toContain("Council score is calculated.");
  });

  it.each([120, 50])("renders the timing-only output entirely as grids at width %i", (width) => {
    const output = renderEvaluationTiming(result(), width);
    const sections = expectClosedGrids(output, width);

    expect(sections).toHaveLength(width >= 100 ? 1 : 2);
    expect(output).toContain("not included in score");
    expectValueCell(output, "Claude");
    expectValueCell(output, "Codex");
    expectValueCell(output, "6s");
  });

  it.each([120, 50])("renders evaluator failures as a bounded grid at width %i", (width) => {
    const output = renderEvaluationFailures(
      [{ evaluator: "claude", error: "Authentication failed; run the provider login command." }],
      width
    );

    expectClosedGrids(output, width);
    expectValueCell(output, "Claude");
    expectValueCell(output, "Failed");
    expect(output).toContain("Authentication failed");
  });
});
