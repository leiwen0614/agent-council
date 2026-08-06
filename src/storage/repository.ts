import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { councilDecisionSchema, councilRunSchema, councilSessionSchema } from "../core/schemas.js";
import {
  PROVIDERS,
  STAGES,
  type CouncilDecision,
  type CouncilEvent,
  type CouncilRun,
  type CouncilSession,
  type EffectiveRunConfig,
  type NewCouncilEvent,
  type ProviderId,
  type ProviderStageState,
  type Stage
} from "../core/types.js";
import { CouncilError } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import { makeRunId, nowIso } from "../util/time.js";
import { appendEventRecord, createCouncilEvent, inspectEventLog } from "./events.js";
import { readValidatedJson, writeJsonAtomic } from "./json.js";
import { CouncilPaths } from "./paths.js";

const ARTIFACT_RELATIVE: Record<Stage, Record<ProviderId, string>> = {
  initial: {
    codex: "answers/codex.md",
    claude: "answers/claude.md",
    copilot: "answers/copilot.md"
  },
  review: { codex: "reviews/codex.md", claude: "reviews/claude.md", copilot: "reviews/copilot.md" },
  final: { codex: "finals/codex.md", claude: "finals/claude.md", copilot: "finals/copilot.md" }
};

const SENSITIVE_DIAGNOSTIC_KEY =
  /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|credential)/i;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function initialProviderState(stage: Stage, provider: ProviderId): ProviderStageState {
  return { status: "waiting", attempts: [], artifact: ARTIFACT_RELATIVE[stage][provider] };
}

function initialStage(stage: Stage): CouncilRun["stages"][Stage] {
  return {
    status: "pending",
    startedAt: null,
    finishedAt: null,
    providers: {
      codex: initialProviderState(stage, "codex"),
      claude: initialProviderState(stage, "claude"),
      copilot: initialProviderState(stage, "copilot")
    }
  };
}

export class CouncilRepository {
  readonly paths: CouncilPaths;
  private readonly eventOperations = new Map<string, Promise<void>>();
  private readonly eventStates = new Map<
    string,
    { sequence: number; needsLineBreakBeforeAppend: boolean }
  >();
  private readonly metadataOperations = new Map<string, Promise<void>>();

  constructor(projectRoot: string) {
    this.paths = new CouncilPaths(projectRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.paths.sessionsRoot, { recursive: true });
  }

  async createSession(name: string | null): Promise<CouncilSession> {
    await this.initialize();
    if (name !== null) {
      const duplicate = (await this.listSessions()).find(
        (session) => session.name?.toLocaleLowerCase() === name.toLocaleLowerCase()
      );
      if (duplicate) {
        throw new CouncilError("SESSION_NAME_EXISTS", `A session named ${name} already exists.`);
      }
    }

    const timestamp = nowIso();
    const session: CouncilSession = {
      schemaVersion: 1,
      id: randomUUID(),
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
      originalProjectRoot: this.paths.projectRoot,
      activeRunId: null,
      providers: {
        codex: { sessionId: null, updatedAt: timestamp },
        claude: { sessionId: null, updatedAt: timestamp },
        copilot: { sessionId: null, updatedAt: timestamp }
      }
    };
    await writeJsonAtomic(this.paths.sessionJson(session.id), session);
    return session;
  }

  async loadSession(id: string): Promise<CouncilSession> {
    return readValidatedJson(this.paths.sessionJson(id), councilSessionSchema);
  }

  async saveSession(session: CouncilSession): Promise<void> {
    const path = this.paths.sessionJson(session.id);
    await this.withOperation(this.metadataOperations, path, async () => {
      session.updatedAt = nowIso();
      await writeJsonAtomic(path, councilSessionSchema.parse(session));
    });
  }

  async listSessions(): Promise<CouncilSession[]> {
    await this.initialize();
    const entries = await readdir(this.paths.sessionsRoot, { withFileTypes: true });
    const sessions: CouncilSession[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        sessions.push(await this.loadSession(entry.name));
      } catch {
        // A corrupt session is reported when selected; it must not hide healthy sessions.
      }
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async resolveSession(idOrName: string): Promise<CouncilSession> {
    const sessions = await this.listSessions();
    const normalized = idOrName.toLocaleLowerCase();
    const matches = sessions.filter(
      (session) => session.id === idOrName || session.name?.toLocaleLowerCase() === normalized
    );
    if (matches.length === 0) {
      throw new CouncilError("SESSION_NOT_FOUND", `No Council session matches ${idOrName}.`);
    }
    if (matches.length > 1) {
      throw new CouncilError(
        "SESSION_AMBIGUOUS",
        `More than one Council session matches ${idOrName}.`
      );
    }
    const match = matches[0];
    if (!match) {
      throw new CouncilError("SESSION_NOT_FOUND", `No Council session matches ${idOrName}.`);
    }
    return match;
  }

  async createRun(
    session: CouncilSession,
    prompt: string,
    effectiveConfig: EffectiveRunConfig
  ): Promise<CouncilRun> {
    if (session.activeRunId !== null) {
      const active = await this.loadRun(session.id, session.activeRunId);
      if (active.status !== "completed" && active.status !== "abandoned") {
        throw new CouncilError(
          "UNFINISHED_RUN",
          `Session ${session.id} has unfinished run ${active.id}.`
        );
      }
    }
    const baseId = makeRunId();
    let id = baseId;
    let suffix = 1;
    while (await exists(this.paths.runRoot(session.id, id))) {
      id = `${baseId}-${String(suffix)}`;
      suffix += 1;
    }
    const timestamp = nowIso();
    const run: CouncilRun = {
      schemaVersion: 1,
      id,
      sessionId: session.id,
      status: "initial_pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      eventSequence: 0,
      degraded: false,
      effectiveConfig,
      stages: {
        initial: initialStage("initial"),
        review: initialStage("review"),
        final: initialStage("final")
      },
      reviewMappings: {},
      degradedContinuations: []
    };
    const root = this.paths.runRoot(session.id, id);
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(this.paths.artifact(session.id, id, "initial", "codex").replace(/[/\\][^/\\]+$/, ""), {
        recursive: true
      }),
      mkdir(this.paths.artifact(session.id, id, "review", "codex").replace(/[/\\][^/\\]+$/, ""), {
        recursive: true
      }),
      mkdir(this.paths.artifact(session.id, id, "final", "codex").replace(/[/\\][^/\\]+$/, ""), {
        recursive: true
      })
    ]);
    await writeFile(this.paths.prompt(session.id, id), prompt, { encoding: "utf8", flag: "wx" });
    await writeFile(this.paths.events(session.id, id), "", { encoding: "utf8", flag: "wx" });
    await this.saveRun(run);
    session.activeRunId = id;
    await this.saveSession(session);
    return run;
  }

  async loadRun(sessionId: string, runId: string): Promise<CouncilRun> {
    return readValidatedJson(this.paths.runJson(sessionId, runId), councilRunSchema);
  }

  async saveRun(run: CouncilRun): Promise<void> {
    const path = this.paths.runJson(run.sessionId, run.id);
    await this.withOperation(this.metadataOperations, path, async () => {
      run.updatedAt = nowIso();
      await writeJsonAtomic(path, councilRunSchema.parse(run));
    });
  }

  async listRuns(sessionId: string): Promise<CouncilRun[]> {
    const root = this.paths.runsRoot(sessionId);
    if (!(await exists(root))) {
      return [];
    }
    const entries = await readdir(root, { withFileTypes: true });
    const runs: CouncilRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        runs.push(await this.loadRun(sessionId, entry.name));
      } catch {
        // Invalid runs remain on disk and will surface if directly resumed.
      }
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async latestRun(sessionId: string): Promise<CouncilRun | null> {
    return (await this.listRuns(sessionId))[0] ?? null;
  }

  async readPrompt(run: CouncilRun): Promise<string> {
    return readFile(this.paths.prompt(run.sessionId, run.id), "utf8");
  }

  async appendEvent(run: CouncilRun, input: NewCouncilEvent): Promise<CouncilEvent> {
    if (input.sessionId !== run.sessionId || input.runId !== run.id) {
      throw new CouncilError(
        "EVENT_CONTEXT_MISMATCH",
        "The event does not belong to the supplied Council run."
      );
    }

    const path = this.paths.events(run.sessionId, run.id);
    return this.withEventOperation(path, async () => {
      let state = this.eventStates.get(path);
      if (state === undefined) {
        const snapshot = await inspectEventLog(
          path,
          { sessionId: run.sessionId, runId: run.id },
          true
        );
        state = {
          sequence: snapshot.events.length,
          needsLineBreakBeforeAppend: snapshot.needsLineBreakBeforeAppend
        };
        this.eventStates.set(path, state);
      }
      const event = createCouncilEvent(input, state.sequence + 1);
      await appendEventRecord(path, event, state.needsLineBreakBeforeAppend);
      state.sequence = event.sequence;
      state.needsLineBreakBeforeAppend = false;

      // events.jsonl is authoritative if interruption happens between these two writes.
      // The next append derives its sequence from the log and repairs this counter.
      run.eventSequence = event.sequence;
      if (!["provider.prose", "provider.progress", "diagnostic"].includes(input.kind)) {
        await this.saveRun(run);
      }
      return event;
    });
  }

  async readEvents(run: CouncilRun): Promise<CouncilEvent[]> {
    const path = this.paths.events(run.sessionId, run.id);
    return this.withEventOperation(path, async () => {
      const snapshot = await inspectEventLog(
        path,
        {
          sessionId: run.sessionId,
          runId: run.id
        },
        true
      );
      return snapshot.events;
    });
  }

  clearEventState(run: CouncilRun): void {
    this.eventStates.delete(this.paths.events(run.sessionId, run.id));
  }

  async readArtifact(run: CouncilRun, stage: Stage, provider: ProviderId): Promise<string | null> {
    const path = this.paths.artifact(run.sessionId, run.id, stage, provider);
    if (!(await exists(path))) {
      return null;
    }
    return readFile(path, "utf8");
  }

  async prepareAttempt(run: CouncilRun, stage: Stage, provider: ProviderId): Promise<void> {
    const partial = this.paths.partialArtifact(run.sessionId, run.id, stage, provider);
    const complete = this.paths.artifact(run.sessionId, run.id, stage, provider);
    for (const interruptedArtifact of [partial, complete]) {
      if (!(await exists(interruptedArtifact))) continue;
      let attempt = Math.max(1, run.stages[stage].providers[provider].attempts.length);
      let archived = this.paths.attemptPartial(run.sessionId, run.id, stage, provider, attempt);
      while (await exists(archived)) {
        attempt += 1;
        archived = this.paths.attemptPartial(run.sessionId, run.id, stage, provider, attempt);
      }
      await rename(interruptedArtifact, archived);
    }
    await mkdir(dirname(partial), { recursive: true });
    await writeFile(partial, "", { encoding: "utf8", flag: "wx" });
  }

  async appendProse(
    run: CouncilRun,
    stage: Stage,
    provider: ProviderId,
    text: string
  ): Promise<void> {
    await appendFile(
      this.paths.partialArtifact(run.sessionId, run.id, stage, provider),
      redactSecrets(text),
      "utf8"
    );
  }

  async artifactHasContent(run: CouncilRun, stage: Stage, provider: ProviderId): Promise<boolean> {
    const partial = this.paths.partialArtifact(run.sessionId, run.id, stage, provider);
    if (!(await exists(partial))) {
      return false;
    }
    return (await readFile(partial, "utf8")).trim().length > 0;
  }

  async completeArtifact(run: CouncilRun, stage: Stage, provider: ProviderId): Promise<void> {
    const partial = this.paths.partialArtifact(run.sessionId, run.id, stage, provider);
    const complete = this.paths.artifact(run.sessionId, run.id, stage, provider);
    if (!(await exists(partial))) {
      throw new CouncilError(
        "MISSING_PARTIAL_ARTIFACT",
        `No partial artifact exists for ${stage}/${provider}.`
      );
    }
    await rename(partial, complete);
  }

  async writeStagePrompt(
    run: CouncilRun,
    stage: Stage,
    provider: ProviderId,
    prompt: string
  ): Promise<string> {
    const path = this.paths.stagePrompt(run.sessionId, run.id, stage, provider);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, prompt, "utf8");
    return path;
  }

  async appendDiagnostic(
    run: CouncilRun,
    stage: Stage,
    provider: ProviderId,
    record: Record<string, unknown>
  ): Promise<void> {
    const path = this.paths.diagnostic(run.sessionId, run.id, stage, provider);
    await mkdir(dirname(path), { recursive: true });
    const redacted = JSON.stringify(record, (key, value: unknown) => {
      if (key.length > 0 && SENSITIVE_DIAGNOSTIC_KEY.test(key)) {
        return "[REDACTED]";
      }
      return typeof value === "string" ? redactSecrets(value) : value;
    });
    await appendFile(path, redacted + "\n", "utf8");
  }

  async saveDecision(run: CouncilRun, decision: CouncilDecision): Promise<void> {
    await writeJsonAtomic(
      this.paths.decision(run.sessionId, run.id),
      councilDecisionSchema.parse(decision)
    );
  }

  async loadDecision(run: CouncilRun): Promise<CouncilDecision | null> {
    const path = this.paths.decision(run.sessionId, run.id);
    if (!(await exists(path))) {
      return null;
    }
    return readValidatedJson(path, councilDecisionSchema);
  }

  async exportProviderFinal(
    run: CouncilRun,
    provider: ProviderId,
    outputPath?: string
  ): Promise<string> {
    const source = this.paths.artifact(run.sessionId, run.id, "final", provider);
    if (!(await exists(source))) {
      throw new CouncilError("FINAL_NOT_FOUND", `The ${provider} final report is not available.`);
    }
    const target = outputPath ?? this.paths.finalExport(run.sessionId, run.id);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    return target;
  }

  async abandonRun(session: CouncilSession, run: CouncilRun): Promise<void> {
    run.status = "abandoned";
    await this.saveRun(run);
    await this.finishRun(session, run);
  }

  async setProviderSessionId(
    session: CouncilSession,
    provider: ProviderId,
    providerSessionId: string
  ): Promise<void> {
    const existing = session.providers[provider].sessionId;
    if (existing !== null && existing !== providerSessionId) {
      throw new CouncilError(
        "PROVIDER_SESSION_MISMATCH",
        `${provider} reported session ${providerSessionId}, but the Council session is mapped to ${existing}.`
      );
    }
    session.providers[provider] = { sessionId: providerSessionId, updatedAt: nowIso() };
    await this.saveSession(session);
  }

  async finishRun(session: CouncilSession, run: CouncilRun): Promise<void> {
    if (run.status === "completed" || run.status === "abandoned") {
      session.activeRunId = null;
      await this.saveSession(session);
    }
  }

  async ensureArtifactDirectories(run: CouncilRun): Promise<void> {
    await Promise.all(
      STAGES.flatMap((stage) =>
        PROVIDERS.map((provider) =>
          mkdir(dirname(this.paths.artifact(run.sessionId, run.id, stage, provider)), {
            recursive: true
          })
        )
      )
    );
  }

  private async withEventOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    return this.withOperation(this.eventOperations, path, operation);
  }

  private async withOperation<T>(
    operations: Map<string, Promise<void>>,
    path: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = operations.get(path) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined
    );
    operations.set(path, settled);

    try {
      return await current;
    } finally {
      if (operations.get(path) === settled) {
        operations.delete(path);
      }
    }
  }
}
