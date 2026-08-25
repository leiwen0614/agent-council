import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlindEvaluationResult } from "../../src/core/evaluation-types.js";
import { CouncilRepository } from "../../src/storage/repository.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function blind(evaluator: "codex" | "claude" = "codex"): BlindEvaluationResult {
  const dimension = { score: 8, rationale: "Auditable rationale." };
  return {
    schemaVersion: 1,
    evaluator,
    candidateIds: ["Candidate A", "Candidate B"],
    inputSha256: "a".repeat(64),
    scoresLockedAt: "2026-08-25T00:00:00.000Z",
    candidates: ["Candidate A", "Candidate B"].map((candidateId) => ({
      candidateId: candidateId as "Candidate A" | "Candidate B",
      dimensions: {
        correctness: dimension,
        taskFulfillment: dimension,
        evidenceQuality: dimension,
        reasoningRigor: dimension,
        critiqueQuality: dimension,
        synthesisImprovement: dimension,
        clarityActionability: dimension
      },
      criticalError: { present: false, categories: [], evidence: null },
      rawTotal: 80,
      capApplied: false,
      finalScore: 80
    }))
  };
}

describe("evaluation persistence", () => {
  it("locks exact anonymous bytes and refuses overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-eval-storage-"));
    temporaryDirectories.push(root);
    const repository = new CouncilRepository(root);
    const session = await repository.createSession("evaluation");
    const run = await repository.createRun(session, "prompt", DEFAULT_CONFIG);
    const value = blind();

    const bytes = await repository.lockBlindEvaluation(run, value);
    expect(await readFile(repository.paths.blindEvaluation(session.id, run.id, "codex"))).toEqual(
      bytes
    );
    expect(bytes.toString()).not.toMatch(/claude|copilot|provider|relationship/iu);
    await expect(repository.lockBlindEvaluation(run, value)).rejects.toMatchObject({
      code: "BLIND_EVAL_EXISTING_INVALID"
    });
  });

  it("keeps evaluators in separate files", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-eval-storage-"));
    temporaryDirectories.push(root);
    const repository = new CouncilRepository(root);
    const session = await repository.createSession("evaluation");
    const run = await repository.createRun(session, "prompt", DEFAULT_CONFIG);
    await repository.lockBlindEvaluation(run, blind("codex"));
    await repository.lockBlindEvaluation(run, blind("claude"));
    expect(await repository.loadBlindEvaluation(run, "codex")).toMatchObject({
      evaluator: "codex"
    });
    expect(await repository.loadBlindEvaluation(run, "claude")).toMatchObject({
      evaluator: "claude"
    });
  });
});
