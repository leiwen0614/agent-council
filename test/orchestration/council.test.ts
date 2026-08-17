import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CouncilConfig, ProviderId } from "../../src/core/types.js";
import { CouncilEngine } from "../../src/orchestration/council.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentProcess,
  AgentProcessResult,
  StartOptions
} from "../../src/providers/index.js";
import { CouncilRepository } from "../../src/storage/repository.js";

const temporaryDirectories: string[] = [];
const config: CouncilConfig = {
  enabledProviders: ["codex", "claude", "copilot"],
  agents: {
    codex: { yolo: false, model: null, effort: null },
    claude: { yolo: false, model: null, effort: null },
    copilot: { yolo: false, model: null, effort: null }
  }
};

function processFrom(provider: ProviderId, prompt: string, success = true): AgentProcess {
  const sessionId = `${provider}-session`;
  const eventValues: AgentEvent[] = [{ type: "session", sessionId, raw: "session" }];
  if (success)
    eventValues.push({
      type: "prose",
      text: `${provider} response to ${prompt.slice(0, 24)}`,
      raw: "prose"
    });
  async function* events(): AsyncGenerator<AgentEvent> {
    for (const event of eventValues) yield await Promise.resolve(event);
  }
  const result: AgentProcessResult = {
    exitCode: success ? 0 : 1,
    signal: null,
    cancelled: false,
    sessionId,
    error: success ? null : "test failure"
  };
  return {
    pid: undefined,
    events: events(),
    completion: Promise.resolve(result),
    cancel: () => Promise.resolve()
  };
}

function deferredProcess(
  provider: ProviderId,
  prompt: string
): {
  process: AgentProcess;
  finish(): void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sessionId = `${provider}-session`;
  async function* events(): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId, raw: "session" };
    await gate;
    yield {
      type: "prose",
      text: `${provider} response to ${prompt.slice(0, 24)}`,
      raw: "prose"
    };
  }
  return {
    process: {
      pid: undefined,
      events: events(),
      completion: gate.then(() => ({
        exitCode: 0,
        signal: null,
        cancelled: false,
        sessionId,
        error: null
      })),
      cancel: () => Promise.resolve()
    },
    finish: release
  };
}

class FakeAdapter implements AgentAdapter {
  private calls = 0;
  readonly yoloValues: boolean[] = [];
  readonly modelValues: (string | null)[] = [];
  readonly effortValues: (string | null)[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly failFirst = false
  ) {}
  checkInstalled() {
    return Promise.resolve({ ok: true, summary: "installed" });
  }
  checkAuthenticated() {
    return Promise.resolve({ ok: true, summary: "authenticated" });
  }
  start(options: StartOptions) {
    this.calls += 1;
    this.yoloValues.push(options.yolo);
    this.modelValues.push(options.model);
    this.effortValues.push(options.effort);
    return processFrom(this.id, options.prompt, !(this.failFirst && this.calls === 1));
  }
  resume(options: StartOptions) {
    return this.start(options);
  }
}

async function fixture(failFirstCodex = false) {
  const root = await mkdtemp(join(tmpdir(), "agent-council-engine-"));
  temporaryDirectories.push(root);
  const repository = new CouncilRepository(root);
  const session = await repository.createSession("test");
  const adapters = {
    codex: new FakeAdapter("codex", failFirstCodex),
    claude: new FakeAdapter("claude"),
    copilot: new FakeAdapter("copilot")
  };
  return { root, repository, session, adapters };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("CouncilEngine", () => {
  it("preflight proceeds with two ready providers and refuses only one", async () => {
    const { repository, adapters } = await fixture();
    adapters.claude.checkAuthenticated = () =>
      Promise.resolve({ ok: false, summary: "offline", remediation: "retry later" });
    const engine = new CouncilEngine({
      repository,
      config,
      adapters,
      live: false,
      recover: () => Promise.resolve("abandon")
    });
    await expect(engine.preflight()).resolves.toBeUndefined();

    adapters.copilot.checkAuthenticated = () =>
      Promise.resolve({ ok: false, summary: "offline", remediation: "login" });
    const insufficient = new CouncilEngine({
      repository,
      config,
      adapters,
      live: false,
      recover: () => Promise.resolve("abandon")
    });
    await expect(insufficient.preflight()).rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
  });

  it("runs all three providers through all three concurrent stages", async () => {
    const { repository, session, adapters } = await fixture();
    const engine = new CouncilEngine({
      repository,
      config,
      adapters,
      live: false,
      recover: () => Promise.resolve("abandon")
    });

    const run = await engine.start(session, "Research this exact prompt.");

    expect(run.status).toBe("awaiting_decision");
    for (const stage of ["initial", "review", "final"] as const) {
      for (const provider of ["codex", "claude", "copilot"] as const) {
        expect(run.stages[stage].providers[provider].status).toBe("completed");
        expect(await repository.readArtifact(run, stage, provider)).toContain(
          `${provider} response`
        );
      }
    }
    expect(await readFile(repository.paths.prompt(session.id, run.id), "utf8")).toBe(
      "Research this exact prompt."
    );
    expect(
      (await repository.readEvents(run)).filter((event) => event.kind === "stage.completed")
    ).toHaveLength(3);
  });

  it("runs a valid two-provider Council and skips the disabled provider", async () => {
    const { repository, session, adapters } = await fixture();
    const twoProviderConfig: CouncilConfig = {
      ...config,
      enabledProviders: ["codex", "copilot"]
    };
    const engine = new CouncilEngine({
      repository,
      config: twoProviderConfig,
      adapters,
      live: false,
      recover: () => Promise.resolve("abandon")
    });

    const run = await engine.start(session, "Two provider test.");

    expect(run.effectiveConfig.enabledProviders).toEqual(["codex", "copilot"]);
    expect(run.status).toBe("awaiting_decision");
    for (const stage of ["initial", "review", "final"] as const) {
      expect(run.stages[stage].providers.codex.status).toBe("completed");
      expect(run.stages[stage].providers.copilot.status).toBe("completed");
      expect(run.stages[stage].providers.claude.status).toBe("skipped");
    }
  });

  it("uses the two ready providers selected by preflight", async () => {
    const { repository, session, adapters } = await fixture();
    adapters.claude.checkAuthenticated = () =>
      Promise.resolve({ ok: false, summary: "offline", remediation: "retry later" });
    const engine = new CouncilEngine({
      repository,
      config,
      adapters,
      live: false,
      recover: () => Promise.resolve("abandon")
    });

    await engine.preflight();
    const run = await engine.start(session, "Availability test.");

    expect(run.effectiveConfig.enabledProviders).toEqual(["codex", "copilot"]);
    expect(run.stages.initial.providers.claude.status).toBe("skipped");
    expect(run.status).toBe("awaiting_decision");
  });

  it("retries only a failed provider and preserves completed peer artifacts", async () => {
    const { repository, session, adapters } = await fixture(true);
    const choices: string[] = [];
    const engine = new CouncilEngine({
      repository,
      config,
      adapters,
      live: false,
      recover: () => {
        choices.push("retry");
        return Promise.resolve("retry" as const);
      }
    });

    const run = await engine.start(session, "Retry test.");

    expect(choices).toEqual(["retry"]);
    expect(run.stages.initial.providers.codex.attempts).toHaveLength(2);
    expect(run.stages.initial.providers.claude.attempts).toHaveLength(1);
    const initialEvents = (await repository.readEvents(run)).filter(
      (event) => event.stage === "initial"
    );
    expect(initialEvents.filter((event) => event.kind === "stage.started")).toHaveLength(2);
    expect(initialEvents.filter((event) => event.kind === "stage.completed")).toHaveLength(1);
    expect(initialEvents.at(-1)?.kind).toBe("stage.completed");
    expect(run.status).toBe("awaiting_decision");
  });

  it("records stage.started before any provider can complete", async () => {
    const { repository, session, adapters } = await fixture();
    const pending = {
      codex: deferredProcess("codex", "event order"),
      claude: deferredProcess("claude", "event order"),
      copilot: deferredProcess("copilot", "event order")
    };
    for (const provider of ["codex", "claude", "copilot"] as const) {
      adapters[provider].start = () => pending[provider].process;
    }
    const engine = new CouncilEngine({
      repository,
      config,
      adapters,
      live: false,
      recover: () => Promise.resolve("abandon")
    });

    const execution = engine.start(session, "Event order test.");
    let run: Awaited<ReturnType<CouncilRepository["latestRun"]>> = null;
    await expect
      .poll(async () => {
        run = await repository.latestRun(session.id);
        return run;
      })
      .not.toBeNull();
    expect(run).not.toBeNull();
    await expect
      .poll(async () => {
        const current = run;
        return current === null ? [] : await repository.readEvents(current);
      })
      .toSatisfy((events: Awaited<ReturnType<CouncilRepository["readEvents"]>>) =>
        events.some((event) => event.kind === "stage.started")
      );
    run = await repository.latestRun(session.id);
    const firstEvents = run === null ? [] : await repository.readEvents(run);
    expect(firstEvents[0]).toMatchObject({ stage: "initial", kind: "stage.started" });
    expect(firstEvents.some((event) => event.kind === "provider.completed")).toBe(false);

    for (const item of Object.values(pending)) item.finish();
    await execution;
  });

  it("resumes with the persisted per-provider permission settings", async () => {
    const { repository, session, adapters } = await fixture();
    const run = await repository.createRun(session, "Persisted permission test.", {
      enabledProviders: config.enabledProviders,
      agents: {
        codex: { yolo: true, model: "gpt-5.6-sol", effort: "xhigh" },
        claude: { yolo: false, model: "claude-opus-4-8", effort: "xhigh" },
        copilot: { yolo: true, model: "gpt-5.6-sol", effort: "max" }
      }
    });
    const engine = new CouncilEngine({
      repository,
      config,
      adapters,
      live: false,
      recover: () => Promise.resolve("abandon")
    });

    await engine.resume(session, run);

    expect(adapters.codex.yoloValues).toEqual([true, true, true]);
    expect(adapters.claude.yoloValues).toEqual([false, false, false]);
    expect(adapters.copilot.yoloValues).toEqual([true, true, true]);
    expect(adapters.codex.modelValues).toEqual(Array(3).fill("gpt-5.6-sol"));
    expect(adapters.codex.effortValues).toEqual(Array(3).fill("xhigh"));
    expect(adapters.claude.modelValues).toEqual(Array(3).fill("claude-opus-4-8"));
    expect(adapters.claude.effortValues).toEqual(Array(3).fill("xhigh"));
    expect(adapters.copilot.modelValues).toEqual(Array(3).fill("gpt-5.6-sol"));
    expect(adapters.copilot.effortValues).toEqual(Array(3).fill("max"));
  });
});
