import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AgentEvent,
  AgentProcess,
  AgentProcessResult,
  StartOptions
} from "../../src/providers/index.js";
import type { CouncilRun, ProviderId } from "../../src/core/types.js";
import { BlindEvaluationEngine } from "../../src/orchestration/evaluation.js";
import { CouncilRepository } from "../../src/storage/repository.js";

const temporaryDirectories: string[] = [];

function evaluatorJson() {
  const dimension = { score: 8, rationale: "Specific evidence-based rationale." };
  return JSON.stringify({
    schemaVersion: 1,
    candidates: ["Candidate A", "Candidate B"].map((candidateId) => ({
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
      criticalError: { present: false, categories: [], evidence: null }
    }))
  });
}

function processWith(output: string, gate?: Promise<void>): AgentProcess {
  async function* events(): AsyncGenerator<AgentEvent> {
    if (gate !== undefined) await gate;
    yield { type: "prose", text: output, raw: output };
  }
  const completion: Promise<AgentProcessResult> = (gate ?? Promise.resolve()).then(() => ({
    exitCode: 0,
    signal: null,
    cancelled: false,
    sessionId: "fresh-evaluation-session",
    error: null
  }));
  return { pid: undefined, events: events(), completion, cancel: () => Promise.resolve() };
}

function failedProcess(message = "provider failed"): AgentProcess {
  async function* events(): AsyncGenerator<AgentEvent> {
    await Promise.resolve();
    yield { type: "diagnostic", text: message, raw: message };
  }
  return {
    pid: undefined,
    events: events(),
    completion: Promise.resolve({
      exitCode: 1,
      signal: null,
      cancelled: false,
      sessionId: null,
      error: message
    }),
    cancel: () => Promise.resolve()
  };
}

class FakeAdapter implements AgentAdapter {
  readonly starts: StartOptions[] = [];
  resumeCalls = 0;
  constructor(
    readonly id: ProviderId,
    private readonly makeProcess: () => AgentProcess = () => processWith(evaluatorJson())
  ) {}
  checkInstalled() {
    return Promise.resolve({ ok: true, summary: "installed" });
  }
  checkAuthenticated() {
    return Promise.resolve({ ok: true, summary: "authenticated" });
  }
  start(options: StartOptions) {
    this.starts.push(options);
    return this.makeProcess();
  }
  resume() {
    this.resumeCalls += 1;
    return this.makeProcess();
  }
}

async function completeRun(
  repository: CouncilRepository
): Promise<{ run: CouncilRun; sessionId: string }> {
  const session = await repository.createSession("blind evaluation");
  const run = await repository.createRun(session, "Evaluate every candidate.", {
    enabledProviders: ["codex", "claude"],
    agents: {
      codex: { yolo: true, model: "test-codex-model", effort: "high" },
      claude: { yolo: true, model: "test-claude-model", effort: "high" },
      copilot: { yolo: true, model: "test-copilot-model", effort: "high" }
    }
  });
  const artifacts = {
    initial: "Initial answer.",
    review: "Review of Answer A.",
    final: "Final report."
  } as const;
  for (const stage of ["initial", "review", "final"] as const) {
    run.stages[stage].status = "completed";
    for (const provider of ["codex", "claude"] as const) {
      await repository.prepareAttempt(run, stage, provider);
      await repository.appendProse(run, stage, provider, `${provider} ${artifacts[stage]}`);
      await repository.completeArtifact(run, stage, provider);
      run.stages[stage].providers[provider].status = "completed";
      run.stages[stage].providers[provider].attempts = [
        {
          number: 1,
          status: "completed",
          startedAt: "2026-08-25T00:00:00.000Z",
          finishedAt: "2026-08-25T00:00:01.000Z"
        }
      ];
      run.stages[stage].providers.copilot.status = "skipped";
    }
  }
  run.reviewMappings = {
    codex: { labels: [{ label: "Answer A", provider: "claude" }], displayOrder: ["Answer A"] },
    claude: { labels: [{ label: "Answer A", provider: "codex" }], displayOrder: ["Answer A"] }
  };
  run.status = "awaiting_decision";
  await repository.saveRun(run);
  return { run, sessionId: session.id };
}

async function fixture(adapters?: Record<ProviderId, FakeAdapter>) {
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-council-eval-engine-"));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-council-eval-isolation-"));
  temporaryDirectories.push(projectRoot, temporaryRoot);
  const repository = new CouncilRepository(projectRoot);
  const { run, sessionId } = await completeRun(repository);
  const values =
    adapters ??
    ({
      codex: new FakeAdapter("codex"),
      claude: new FakeAdapter("claude"),
      copilot: new FakeAdapter("copilot")
    } satisfies Record<ProviderId, FakeAdapter>);
  const engine = new BlindEvaluationEngine({ repository, adapters: values, temporaryRoot });
  return { engine, repository, run, sessionId, temporaryRoot, adapters: values };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("BlindEvaluationEngine", () => {
  it("uses one fresh safe isolated evaluator session and preserves Council session mappings", async () => {
    const { engine, repository, run, sessionId, temporaryRoot, adapters } = await fixture();
    const sessionBefore = await repository.loadSession(sessionId);
    const execution = await engine.execute({ session: sessionBefore, run }, "codex");

    expect(execution.failures).toEqual([]);
    expect(execution.results).toHaveLength(1);
    expect(adapters.codex.resumeCalls).toBe(0);
    expect(adapters.codex.starts).toHaveLength(1);
    const start = adapters.codex.starts[0];
    if (start === undefined) throw new Error("Codex evaluator was not started.");
    expect(start).toMatchObject({
      allowNonGitWorkingDirectory: true,
      yolo: false,
      model: "test-codex-model",
      effort: "high"
    });
    expect(start.cwd).not.toBe(repository.paths.projectRoot);
    expect(await readdir(temporaryRoot)).toEqual([]);
    expect((await repository.loadSession(sessionId)).providers).toEqual(sessionBefore.providers);
  });

  it("does not reveal any --by all mapping until every evaluator reaches a terminal state", async () => {
    let finishClaude!: () => void;
    const claudeGate = new Promise<void>((resolve) => {
      finishClaude = resolve;
    });
    const adapters = {
      codex: new FakeAdapter("codex"),
      claude: new FakeAdapter("claude", () => processWith(evaluatorJson(), claudeGate)),
      copilot: new FakeAdapter("copilot")
    } satisfies Record<ProviderId, FakeAdapter>;
    const { engine, repository, run } = await fixture(adapters);
    const session = await repository.loadSession(run.sessionId);
    const execution = engine.execute({ session, run }, "all");

    await expect.poll(() => adapters.codex.starts.length).toBe(1);
    await expect.poll(async () => repository.loadBlindEvaluation(run, "codex")).not.toBeNull();
    expect(await repository.loadResolvedEvaluation(run, "codex")).toBeNull();
    finishClaude();
    await expect(execution).resolves.toMatchObject({ failures: [] });
    expect(await repository.loadResolvedEvaluation(run, "codex")).not.toBeNull();
    expect(await repository.loadResolvedEvaluation(run, "claude")).not.toBeNull();
  });

  it("reuses a completed valid evaluation without starting another provider session", async () => {
    const { engine, repository, run, adapters } = await fixture();
    const session = await repository.loadSession(run.sessionId);
    const first = await engine.execute({ session, run }, "codex");
    const blindPath = repository.paths.blindEvaluation(run.sessionId, run.id, "codex");
    const resolvedPath = repository.paths.resolvedEvaluation(run.sessionId, run.id, "codex");
    const blindTime = (await stat(blindPath)).mtimeMs;
    const resolvedTime = (await stat(resolvedPath)).mtimeMs;

    const second = await engine.execute({ session, run }, "codex");

    expect(second).toEqual(first);
    expect(adapters.codex.starts).toHaveLength(1);
    expect((await stat(blindPath)).mtimeMs).toBe(blindTime);
    expect((await stat(resolvedPath)).mtimeMs).toBe(resolvedTime);
  });

  it("rejects corrupt Stage 2 mappings before launching an evaluator", async () => {
    const { engine, repository, run, adapters } = await fixture();
    run.reviewMappings.codex = {
      labels: [{ label: "Answer A", provider: "codex" }],
      displayOrder: ["Answer A"]
    };
    await repository.saveRun(run);
    const session = await repository.loadSession(run.sessionId);

    await expect(engine.execute({ session, run }, "codex")).rejects.toMatchObject({
      code: "BLIND_EVAL_RUN_INELIGIBLE"
    });
    expect(adapters.codex.starts).toHaveLength(0);
    expect(await repository.loadBlindEvaluation(run, "codex")).toBeNull();
  });

  it("rejects identifying Stage 2 labels before evaluator preflight", async () => {
    const { engine, repository, run, adapters } = await fixture();
    run.reviewMappings.codex = {
      labels: [{ label: "Claude", provider: "claude" }],
      displayOrder: ["Claude"]
    };
    await repository.saveRun(run);
    const session = await repository.loadSession(run.sessionId);

    await expect(engine.execute({ session, run }, "codex")).rejects.toMatchObject({
      code: "BLIND_EVAL_RUN_INELIGIBLE"
    });
    expect(adapters.codex.starts).toHaveLength(0);
  });

  it.each(["partial stage metadata", "degraded continuation history", "blank prompt"])(
    "rejects an otherwise complete run with %s",
    async (inconsistency) => {
      const { engine, repository, run, adapters } = await fixture();
      if (inconsistency === "partial stage metadata") run.stages.review.status = "partial";
      else if (inconsistency === "degraded continuation history") {
        run.degradedContinuations.push({
          stage: "initial",
          continuedAt: "2026-08-25T00:00:02.000Z",
          included: ["codex", "claude"],
          omitted: []
        });
      } else {
        await writeFile(repository.paths.prompt(run.sessionId, run.id), "  ", "utf8");
      }
      await repository.saveRun(run);
      const session = await repository.loadSession(run.sessionId);

      await expect(engine.execute({ session, run }, "codex")).rejects.toMatchObject({
        code: "BLIND_EVAL_RUN_INELIGIBLE"
      });
      expect(adapters.codex.starts).toHaveLength(0);
    }
  );

  it("reuses a complete evaluation without another preflight or provider start", async () => {
    const { engine, repository, run, adapters } = await fixture();
    const session = await repository.loadSession(run.sessionId);
    const first = await engine.execute({ session, run }, "codex");
    const lockedBefore = await repository.readLockedEvaluationBytes(run, "codex");

    const second = await engine.execute({ session, run }, "codex");

    expect(second).toEqual(first);
    expect(adapters.codex.starts).toHaveLength(1);
    expect(await repository.readLockedEvaluationBytes(run, "codex")).toEqual(lockedBefore);
  });

  it("uses one additional fresh session for a single repair attempt", async () => {
    let invocation = 0;
    const adapters = {
      codex: new FakeAdapter("codex", () => {
        invocation += 1;
        return processWith(invocation === 1 ? "not JSON" : evaluatorJson());
      }),
      claude: new FakeAdapter("claude"),
      copilot: new FakeAdapter("copilot")
    } satisfies Record<ProviderId, FakeAdapter>;
    const { engine, repository, run, temporaryRoot } = await fixture(adapters);
    const session = await repository.loadSession(run.sessionId);

    const execution = await engine.execute({ session, run }, "codex");

    expect(execution.failures).toEqual([]);
    expect(adapters.codex.starts).toHaveLength(2);
    expect(adapters.codex.starts[0]?.cwd).not.toBe(adapters.codex.starts[1]?.cwd);
    expect(adapters.codex.starts[1]?.prompt).toContain("Candidate identities remain hidden");
    expect(adapters.codex.resumeCalls).toBe(0);
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("isolates evaluator failure under --by all and never reveals the failed mapping", async () => {
    const adapters = {
      codex: new FakeAdapter("codex"),
      claude: new FakeAdapter("claude", () => failedProcess()),
      copilot: new FakeAdapter("copilot")
    } satisfies Record<ProviderId, FakeAdapter>;
    const { engine, repository, run } = await fixture(adapters);
    const session = await repository.loadSession(run.sessionId);

    const execution = await engine.execute({ session, run }, "all");

    expect(execution.results.map(({ evaluator }) => evaluator)).toEqual(["codex"]);
    expect(execution.failures).toHaveLength(1);
    expect(execution.failures[0]).toMatchObject({ evaluator: "claude" });
    expect(await repository.loadResolvedEvaluation(run, "codex")).not.toBeNull();
    expect(await repository.loadBlindEvaluation(run, "claude")).toBeNull();
    expect(await repository.loadResolvedEvaluation(run, "claude")).toBeNull();
  });

  it("does not lock or reveal scores when both output attempts are invalid", async () => {
    const adapters = {
      codex: new FakeAdapter("codex", () => processWith("still not JSON")),
      claude: new FakeAdapter("claude"),
      copilot: new FakeAdapter("copilot")
    } satisfies Record<ProviderId, FakeAdapter>;
    const { engine, repository, run } = await fixture(adapters);
    const session = await repository.loadSession(run.sessionId);

    const execution = await engine.execute({ session, run }, "codex");

    expect(execution.results).toEqual([]);
    expect(execution.failures).toHaveLength(1);
    expect(adapters.codex.starts).toHaveLength(2);
    expect(await repository.loadBlindEvaluation(run, "codex")).toBeNull();
    expect(await repository.loadResolvedEvaluation(run, "codex")).toBeNull();
  });
});
