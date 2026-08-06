import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EffectiveRunConfig, NewCouncilEvent } from "../../src/core/types.js";
import { CouncilRepository } from "../../src/storage/repository.js";

const config: EffectiveRunConfig = {
  enabledProviders: ["codex", "copilot"],
  agents: {
    codex: { yolo: false },
    claude: { yolo: false },
    copilot: { yolo: false }
  }
};

const temporaryDirectories: string[] = [];

async function createRun() {
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-council-events-"));
  temporaryDirectories.push(projectRoot);
  const repository = new CouncilRepository(projectRoot);
  const session = await repository.createSession(null);
  const run = await repository.createRun(session, "Preserve this prompt verbatim.", config);
  return { repository, run };
}

function newEvent(
  run: Awaited<ReturnType<typeof createRun>>["run"],
  text: string
): NewCouncilEvent {
  return {
    sessionId: run.sessionId,
    runId: run.id,
    stage: "initial",
    provider: "codex",
    kind: "provider.progress",
    text
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Council event persistence", () => {
  it("serializes concurrent appends and persists the run sequence", async () => {
    const { repository, run } = await createRun();

    const events = await Promise.all(
      ["one", "two", "three"].map((text) => repository.appendEvent(run, newEvent(run, text)))
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect((await repository.readEvents(run)).map((event) => event.text)).toEqual([
      "one",
      "two",
      "three"
    ]);
    expect(run.eventSequence).toBe(3);
  });

  it("redacts secrets before writing an event", async () => {
    const { repository, run } = await createRun();
    const event = newEvent(run, "authorization=do-not-persist");
    event.metadata = { authorization: "do-not-persist", detail: "bearer also-secret" };

    const persisted = await repository.appendEvent(run, event);
    const raw = await readFile(repository.paths.events(run.sessionId, run.id), "utf8");

    expect(persisted.text).toBe("[REDACTED]");
    expect(persisted.metadata).toEqual({
      authorization: "[REDACTED]",
      detail: "[REDACTED]"
    });
    expect(raw).not.toContain("do-not-persist");
    expect(raw).not.toContain("also-secret");
  });

  it("redacts provider prose and nested diagnostics before persistence", async () => {
    const { repository, run } = await createRun();
    await repository.prepareAttempt(run, "initial", "codex");
    await repository.appendProse(run, "initial", "codex", "password=hunter2");
    await repository.appendDiagnostic(run, "initial", "codex", {
      nested: { clientSecret: "not-pattern-shaped" },
      output: "bearer diagnostic-token"
    });

    const prose = await readFile(
      repository.paths.partialArtifact(run.sessionId, run.id, "initial", "codex"),
      "utf8"
    );
    const diagnostic = await readFile(
      repository.paths.diagnostic(run.sessionId, run.id, "initial", "codex"),
      "utf8"
    );

    expect(prose).toBe("[REDACTED]");
    expect(diagnostic).not.toContain("not-pattern-shaped");
    expect(diagnostic).not.toContain("diagnostic-token");
  });

  it("preserves each partial artifact across repeated interrupted attempts", async () => {
    const { repository, run } = await createRun();
    await repository.prepareAttempt(run, "initial", "codex");
    await repository.appendProse(run, "initial", "codex", "first interruption");
    await repository.prepareAttempt(run, "initial", "codex");
    await repository.appendProse(run, "initial", "codex", "second interruption");

    await repository.prepareAttempt(run, "initial", "codex");

    expect(
      await readFile(
        repository.paths.attemptPartial(run.sessionId, run.id, "initial", "codex", 1),
        "utf8"
      )
    ).toBe("first interruption");
    expect(
      await readFile(
        repository.paths.attemptPartial(run.sessionId, run.id, "initial", "codex", 2),
        "utf8"
      )
    ).toBe("second interruption");
    expect(
      await readFile(
        repository.paths.partialArtifact(run.sessionId, run.id, "initial", "codex"),
        "utf8"
      )
    ).toBe("");
  });

  it("recovers when interruption happens after artifact promotion", async () => {
    const { repository, run } = await createRun();
    await repository.prepareAttempt(run, "initial", "codex");
    await repository.appendProse(run, "initial", "codex", "promoted before interruption");
    await repository.completeArtifact(run, "initial", "codex");

    await repository.prepareAttempt(run, "initial", "codex");
    await repository.appendProse(run, "initial", "codex", "successful retry");
    await repository.completeArtifact(run, "initial", "codex");

    expect(
      await readFile(
        repository.paths.attemptPartial(run.sessionId, run.id, "initial", "codex", 1),
        "utf8"
      )
    ).toBe("promoted before interruption");
    expect(await repository.readArtifact(run, "initial", "codex")).toBe("successful retry");
  });

  it("repairs a syntactically torn final record before appending", async () => {
    const { repository, run } = await createRun();
    await repository.appendEvent(run, newEvent(run, "complete"));
    await appendFile(
      repository.paths.events(run.sessionId, run.id),
      '{"schemaVersion":1,"sequence":2',
      "utf8"
    );
    repository.clearEventState(run);

    const recovered = await repository.appendEvent(run, newEvent(run, "after recovery"));

    expect(recovered.sequence).toBe(2);
    expect((await repository.readEvents(run)).map((event) => event.text)).toEqual([
      "complete",
      "after recovery"
    ]);
  });

  it("repairs a syntactically torn final record while reading after interruption", async () => {
    const { repository, run } = await createRun();
    await repository.appendEvent(run, newEvent(run, "complete"));
    await appendFile(repository.paths.events(run.sessionId, run.id), "{torn", "utf8");

    expect((await repository.readEvents(run)).map((event) => event.text)).toEqual(["complete"]);
    expect(await readFile(repository.paths.events(run.sessionId, run.id), "utf8")).not.toContain(
      "{torn"
    );
  });

  it("does not hide a malformed completed record", async () => {
    const { repository, run } = await createRun();
    await appendFile(repository.paths.events(run.sessionId, run.id), "not-json\n", "utf8");

    await expect(repository.readEvents(run)).rejects.toMatchObject({
      code: "STORAGE_EVENT_INVALID"
    });
  });

  it("rejects events for a different run", async () => {
    const { repository, run } = await createRun();

    await expect(
      repository.appendEvent(run, { ...newEvent(run, "wrong"), runId: "another-run" })
    ).rejects.toMatchObject({ code: "EVENT_CONTEXT_MISMATCH" });
    expect(await repository.readEvents(run)).toEqual([]);
  });
});
