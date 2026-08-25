import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BlindCandidateScore,
  BlindEvaluationResult,
  ResolvedEvaluationResult
} from "../../src/core/evaluation-types.js";
import type { EffectiveRunConfig } from "../../src/core/types.js";
import { CouncilRepository } from "../../src/storage/repository.js";

const timestamp = "2026-08-25T00:00:00.000Z";
const configuration: EffectiveRunConfig = {
  enabledProviders: ["codex", "claude"],
  agents: {
    codex: { yolo: false, model: null, effort: null },
    claude: { yolo: false, model: null, effort: null },
    copilot: { yolo: false, model: null, effort: null }
  }
};
const temporaryDirectories: string[] = [];

function dimensions(score: number) {
  const value = { score, rationale: "Specific evidence-based rationale." };
  return {
    correctness: value,
    taskFulfillment: value,
    evidenceQuality: value,
    reasoningRigor: value,
    critiqueQuality: value,
    synthesisImprovement: value,
    clarityActionability: value
  };
}

function score(candidateId: "Candidate A" | "Candidate B"): BlindCandidateScore {
  return {
    candidateId,
    dimensions: dimensions(8),
    criticalError: { present: false, categories: [], evidence: null },
    rawTotal: 80,
    capApplied: false,
    finalScore: 80
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-council-evaluations-"));
  temporaryDirectories.push(root);
  const repository = new CouncilRepository(root);
  const session = await repository.createSession("evaluation test");
  const run = await repository.createRun(session, "Original prompt", configuration);
  return { repository, run };
}

function blind(): BlindEvaluationResult {
  return {
    schemaVersion: 1,
    evaluator: "codex",
    candidateIds: ["Candidate A", "Candidate B"],
    inputSha256: "a".repeat(64),
    scoresLockedAt: timestamp,
    candidates: [score("Candidate A"), score("Candidate B")]
  };
}

function resolved(runId: string, blindResultSha256: string): ResolvedEvaluationResult {
  const missing = { initialMs: null, reviewMs: null, finalMs: null, totalMs: null };
  const available = { initialMs: 1, reviewMs: 2, finalMs: 3, totalMs: 6 };
  return {
    schemaVersion: 1,
    evaluator: "codex",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    runId,
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
      { candidateId: "Candidate B", provider: "claude" }
    ],
    candidates: [
      { ...score("Candidate A"), provider: "codex", relationship: "self" },
      { ...score("Candidate B"), provider: "claude", relationship: "peer" }
    ],
    blindResultSha256,
    durations: { codex: available, claude: available, copilot: missing },
    scoresLockedAt: timestamp,
    identitiesRevealedAt: timestamp,
    warnings: []
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("evaluation persistence", () => {
  it("locks exact blind bytes without identities and refuses replacement", async () => {
    const { repository, run } = await fixture();
    const bytes = await repository.lockBlindEvaluation(run, blind());
    const stored = await readFile(repository.paths.blindEvaluation(run.sessionId, run.id, "codex"));

    expect(stored).toEqual(bytes);
    expect(stored.toString("utf8")).not.toMatch(/claude|copilot|relationship|mapping/iu);
    await expect(repository.lockBlindEvaluation(run, blind())).rejects.toMatchObject({
      code: "BLIND_EVAL_EXISTING_INVALID"
    });
    expect(
      await readFile(repository.paths.blindEvaluation(run.sessionId, run.id, "codex"))
    ).toEqual(bytes);
  });

  it("persists the resolved record separately with the digest of locked bytes", async () => {
    const { repository, run } = await fixture();
    const bytes = await repository.lockBlindEvaluation(run, blind());
    const digest = createHash("sha256").update(bytes).digest("hex");
    const result = resolved(run.id, digest);
    result.sessionId = run.sessionId;

    await repository.saveResolvedEvaluation(run, result);

    expect(await repository.loadBlindEvaluation(run, "codex")).toEqual(blind());
    expect(await repository.loadResolvedEvaluation(run, "codex")).toEqual(result);
  });

  it("distinguishes a missing exact run from corrupt stored metadata", async () => {
    const { repository, run } = await fixture();
    await expect(repository.findRun(run.sessionId, "missing")).rejects.toMatchObject({
      code: "BLIND_EVAL_RUN_NOT_FOUND"
    });

    const path = repository.paths.runJson(run.sessionId, run.id);
    await writeFile(path, "not json", "utf8");
    await expect(repository.findRun(run.sessionId, run.id)).rejects.toMatchObject({
      code: "STORAGE_READ_FAILED"
    });
  });
});
