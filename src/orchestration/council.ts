import type { AgentAdapter, AgentProcess } from "../providers/index.js";
import { createProviderAdapters } from "../providers/index.js";
import {
  buildFinalPrompt,
  buildInitialPrompt,
  createReviewPrompts,
  type ProviderEvidence
} from "../core/prompts.js";
import {
  PROVIDERS,
  type CouncilConfig,
  type CouncilRun,
  type CouncilSession,
  type DiagnosticResult,
  type ProviderId,
  type ProviderStatus,
  type Stage
} from "../core/types.js";
import { CouncilRepository } from "../storage/repository.js";
import { CouncilError } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import { nowIso } from "../util/time.js";
import { CancellationManager } from "./cancellation.js";
import { createLiveView, type LivePanelState, type LiveSnapshot } from "../ui/live.js";

export type DoctorResult = {
  provider: ProviderId;
  installed: DiagnosticResult;
  authenticated: DiagnosticResult;
};
export type RecoveryHandler = (
  stage: Stage,
  canContinue: boolean
) => Promise<"retry" | "continue" | "abandon">;
export type CouncilEngineOptions = {
  repository: CouncilRepository;
  config: CouncilConfig;
  adapters?: Record<ProviderId, AgentAdapter> | undefined;
  recover: RecoveryHandler;
  live?: boolean | undefined;
};

const RUNNING_STATUS: Record<Stage, CouncilRun["status"]> = {
  initial: "initial_running",
  review: "review_running",
  final: "final_running"
};
const RECOVERY_STATUS: Record<Stage, CouncilRun["status"]> = {
  initial: "initial_recovery",
  review: "review_recovery",
  final: "final_recovery"
};
const NEXT_STATUS: Record<Stage, CouncilRun["status"]> = {
  initial: "review_pending",
  review: "final_pending",
  final: "awaiting_decision"
};

export async function runDoctor(
  adapters = createProviderAdapters(),
  providers: ProviderId[] = [...PROVIDERS]
): Promise<DoctorResult[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const installed = await adapters[provider].checkInstalled();
      const authenticated = installed.ok
        ? await adapters[provider].checkAuthenticated()
        : {
            ok: false,
            summary: `${provider} authentication was not checked.`,
            remediation: installed.remediation
          };
      return { provider, installed, authenticated };
    })
  );
}

export class CouncilEngine {
  private readonly adapters: Record<ProviderId, AgentAdapter>;
  private readonly cancellation = new CancellationManager();
  private readyProviders: ProviderId[] | null = null;

  constructor(private readonly options: CouncilEngineOptions) {
    this.adapters = options.adapters ?? createProviderAdapters();
  }

  private get enabledProviders(): ProviderId[] {
    return this.readyProviders ?? this.options.config.enabledProviders;
  }

  async preflight(): Promise<void> {
    const diagnostics = await runDoctor(this.adapters, this.options.config.enabledProviders);
    const failures = diagnostics.filter(
      (result) => !result.installed.ok || !result.authenticated.ok
    );
    const ready = diagnostics
      .filter((result) => result.installed.ok && result.authenticated.ok)
      .map((result) => result.provider);
    if (ready.length < 2) {
      const detail = failures
        .map(
          (result) =>
            `${result.provider}: ${result.authenticated.remediation ?? result.installed.remediation ?? result.authenticated.summary}`
        )
        .join("\n");
      throw new CouncilError(
        "PREFLIGHT_FAILED",
        `Agent Council requires at least two ready providers.\n${detail}`
      );
    }
    this.readyProviders = ready;
    if (failures.length > 0) {
      process.stderr.write(
        `Continuing with ${ready.join(", ")}; unavailable: ${failures
          .map((result) => result.provider)
          .join(", ")}.\n`
      );
    }
  }

  async start(session: CouncilSession, originalPrompt: string): Promise<CouncilRun> {
    const run = await this.options.repository.createRun(session, originalPrompt, {
      agents: this.options.config.agents,
      enabledProviders: this.enabledProviders
    });
    return this.execute(session, run);
  }

  async resume(session: CouncilSession, run: CouncilRun): Promise<CouncilRun> {
    this.readyProviders = run.effectiveConfig.enabledProviders;
    return this.execute(session, run);
  }

  private async execute(session: CouncilSession, run: CouncilRun): Promise<CouncilRun> {
    this.cancellation.install(() =>
      process.stderr.write(
        "\nCancelling providers gracefully. Press Ctrl+C again to force termination.\n"
      )
    );
    try {
      while (!this.cancellation.cancelled) {
        if (
          run.status === "initial_pending" ||
          run.status === "initial_running" ||
          run.status === "initial_recovery"
        ) {
          const prompt = buildInitialPrompt(await this.options.repository.readPrompt(run));
          const outcome = await this.executeRecoverableStage(session, run, "initial", () =>
            Object.fromEntries(this.enabledProviders.map((provider) => [provider, prompt]))
          );
          if (outcome === "abandoned") return run;
          continue;
        }
        if (
          run.status === "review_pending" ||
          run.status === "review_running" ||
          run.status === "review_recovery"
        ) {
          const originalPrompt = await this.options.repository.readPrompt(run);
          const answers = await this.readEvidence(run, "initial");
          const outcome = await this.executeRecoverableStage(session, run, "review", () => {
            const packages = createReviewPrompts({
              originalPrompt,
              initialAnswers: answers,
              reviewMappings: run.reviewMappings
            });
            const prompts: Partial<Record<ProviderId, string>> = {};
            for (const provider of this.enabledProviders) {
              const packageItem = packages[provider];
              if (packageItem) {
                prompts[provider] = packageItem.prompt;
                run.reviewMappings[provider] ??= packageItem.mapping;
              }
            }
            return prompts;
          });
          if (outcome === "abandoned") return run;
          continue;
        }
        if (
          run.status === "final_pending" ||
          run.status === "final_running" ||
          run.status === "final_recovery"
        ) {
          const finalPrompt = buildFinalPrompt({
            originalPrompt: await this.options.repository.readPrompt(run),
            initialAnswers: await this.readEvidence(run, "initial"),
            reviews: await this.readEvidence(run, "review"),
            reviewMappings: run.reviewMappings
          });
          const outcome = await this.executeRecoverableStage(session, run, "final", () =>
            Object.fromEntries(this.enabledProviders.map((provider) => [provider, finalPrompt]))
          );
          if (outcome === "abandoned") return run;
          continue;
        }
        return run;
      }
      return run;
    } finally {
      this.cancellation.uninstall();
    }
  }

  private async executeRecoverableStage(
    session: CouncilSession,
    run: CouncilRun,
    stage: Stage,
    buildPrompts: () => Partial<Record<ProviderId, string>>
  ): Promise<"complete" | "abandoned" | "interrupted"> {
    for (;;) {
      const prompts = buildPrompts();
      const eligible = this.enabledProviders.filter((provider) => prompts[provider] !== undefined);
      await this.options.repository.saveRun(run);
      for (const provider of PROVIDERS.filter(
        (provider) => !this.enabledProviders.includes(provider)
      )) {
        run.stages[stage].providers[provider].status = "skipped";
      }
      const retryable = this.enabledProviders.filter(
        (provider) =>
          run.stages[stage].providers[provider].status !== "completed" &&
          prompts[provider] !== undefined
      );
      const skipped = this.enabledProviders.filter(
        (provider) =>
          run.stages[stage].providers[provider].status !== "completed" &&
          prompts[provider] === undefined
      );
      for (const provider of skipped) run.stages[stage].providers[provider].status = "skipped";
      if (retryable.length > 0) await this.runStage(session, run, stage, prompts, retryable);
      if (this.cancellation.cancelled) {
        run.stages[stage].status = "cancelled";
        run.status = RECOVERY_STATUS[stage];
        await this.options.repository.saveRun(run);
        return "interrupted";
      }
      const completed = this.enabledProviders.filter(
        (provider) => run.stages[stage].providers[provider].status === "completed"
      );
      const completedEligible = eligible.filter((provider) => completed.includes(provider));
      if (eligible.length > 0 && completedEligible.length === eligible.length) {
        const hasEvidenceSkip = eligible.length < this.enabledProviders.length;
        run.stages[stage].status = hasEvidenceSkip ? "partial" : "completed";
        run.stages[stage].finishedAt = nowIso();
        run.status = NEXT_STATUS[stage];
        await this.options.repository.saveRun(run);
        await this.options.repository.appendEvent(run, {
          sessionId: run.sessionId,
          runId: run.id,
          stage,
          provider: null,
          kind: hasEvidenceSkip ? "stage.partial" : "stage.completed"
        });
        return "complete";
      }
      run.status = RECOVERY_STATUS[stage];
      run.stages[stage].status = "partial";
      await this.options.repository.saveRun(run);
      const canContinue = this.canContinue(stage, completed.length, run);
      const choice = await this.options.recover(stage, canContinue);
      if (choice === "retry") continue;
      if (choice === "abandon") {
        await this.options.repository.abandonRun(session, run);
        return "abandoned";
      }
      if (!canContinue)
        throw new CouncilError(
          "INSUFFICIENT_EVIDENCE",
          `The ${stage} stage cannot continue with the available evidence.`
        );
      run.degraded = true;
      run.degradedContinuations.push({
        stage,
        continuedAt: nowIso(),
        included: completed.map((provider) => run.stages[stage].providers[provider].artifact),
        omitted: this.enabledProviders
          .filter((provider) => !completed.includes(provider))
          .map((provider) => run.stages[stage].providers[provider].artifact)
      });
      run.stages[stage].finishedAt = nowIso();
      run.status = NEXT_STATUS[stage];
      await this.options.repository.saveRun(run);
      await this.options.repository.appendEvent(run, {
        sessionId: run.sessionId,
        runId: run.id,
        stage,
        provider: null,
        kind: "stage.partial"
      });
      return "complete";
    }
  }

  private canContinue(stage: Stage, completed: number, run: CouncilRun): boolean {
    if (stage === "initial") return completed > 0;
    if (stage === "review")
      return this.enabledProviders.some(
        (provider) => run.stages.initial.providers[provider].status === "completed"
      );
    return completed > 0;
  }

  private async runStage(
    session: CouncilSession,
    run: CouncilRun,
    stage: Stage,
    prompts: Partial<Record<ProviderId, string>>,
    providers: ProviderId[]
  ): Promise<void> {
    const state = run.stages[stage];
    state.status = "running";
    state.startedAt ??= nowIso();
    run.status = RUNNING_STATUS[stage];
    await this.options.repository.saveRun(run);
    await this.options.repository.appendEvent(run, {
      sessionId: run.sessionId,
      runId: run.id,
      stage,
      provider: null,
      kind: "stage.started"
    });

    const panels = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        { status: state.providers[provider].status, text: "" }
      ])
    ) as Record<ProviderId, LivePanelState>;
    const snapshot: LiveSnapshot = {
      providers: this.enabledProviders,
      sessionLabel: session.name ?? session.id.slice(0, 8),
      runId: run.id,
      stage,
      startedAt: Date.now(),
      panels
    };
    const view =
      this.options.live === false
        ? { update: () => undefined, close: () => undefined }
        : createLiveView(snapshot, this.options.config.ui.maxPanelLines, () =>
            this.cancellation.interrupt()
          );
    try {
      await Promise.all(
        providers.map(async (provider) => {
          const prompt = prompts[provider];
          if (prompt === undefined) return;
          const promptPath = await this.options.repository.writeStagePrompt(
            run,
            stage,
            provider,
            prompt
          );
          const promptReference = this.options.repository.paths.projectRelative(promptPath);
          await this.options.repository.prepareAttempt(run, stage, provider);
          const providerState = state.providers[provider];
          providerState.status = "running";
          panels[provider] = { status: "running", text: "" };
          view.update(snapshot);
          const startedAt = nowIso();
          await this.options.repository.appendEvent(run, {
            sessionId: run.sessionId,
            runId: run.id,
            stage,
            provider,
            kind: "provider.started"
          });
          const existingSessionId = session.providers[provider].sessionId;
          const processHandle =
            existingSessionId === null
              ? this.adapters[provider].start({
                  prompt,
                  cwd: this.options.repository.paths.projectRoot,
                  ...run.effectiveConfig.agents[provider],
                  promptPath: provider === "copilot" ? promptReference : undefined
                })
              : this.adapters[provider].resume({
                  prompt,
                  cwd: this.options.repository.paths.projectRoot,
                  ...run.effectiveConfig.agents[provider],
                  sessionId: existingSessionId,
                  promptPath: provider === "copilot" ? promptReference : undefined
                });
          const remove = this.cancellation.add(processHandle);
          const consume = this.consumeEvents(
            session,
            run,
            stage,
            provider,
            processHandle,
            panels,
            view,
            snapshot
          );
          const result = await processHandle.completion;
          await consume;
          remove();
          if (result.sessionId !== null && existingSessionId === null)
            await this.options.repository.setProviderSessionId(session, provider, result.sessionId);
          const hasContent = await this.options.repository.artifactHasContent(run, stage, provider);
          const completed = result.exitCode === 0 && !result.cancelled && hasContent;
          const status: ProviderStatus = completed
            ? "completed"
            : result.cancelled
              ? "cancelled"
              : "failed";
          providerState.status = status;
          providerState.error = completed
            ? undefined
            : redactSecrets(
                result.error ??
                  (hasContent ? "Provider process failed." : "Provider produced no answer.")
              );
          providerState.attempts.push({
            number: providerState.attempts.length + 1,
            status:
              status === "completed"
                ? "completed"
                : status === "cancelled"
                  ? "cancelled"
                  : "failed",
            startedAt,
            finishedAt: nowIso(),
            ...(providerState.error ? { error: providerState.error } : {})
          });
          if (completed) await this.options.repository.completeArtifact(run, stage, provider);
          panels[provider].status = status;
          if (!completed && providerState.error !== undefined) {
            panels[provider].text += `\n${providerState.error}`;
          }
          view.update(snapshot);
          await this.options.repository.appendEvent(run, {
            sessionId: run.sessionId,
            runId: run.id,
            stage,
            provider,
            kind: completed
              ? "provider.completed"
              : result.cancelled
                ? "provider.cancelled"
                : "provider.failed",
            ...(providerState.error ? { text: providerState.error } : {})
          });
          await this.options.repository.saveRun(run);
        })
      );
    } finally {
      view.close();
    }
  }

  private async consumeEvents(
    session: CouncilSession,
    run: CouncilRun,
    stage: Stage,
    provider: ProviderId,
    processHandle: AgentProcess,
    panels: Record<ProviderId, LivePanelState>,
    view: { update(snapshot: LiveSnapshot): void },
    snapshot: LiveSnapshot
  ): Promise<void> {
    for await (const event of processHandle.events) {
      if (event.type === "session") {
        if (session.providers[provider].sessionId === null) {
          await this.options.repository.setProviderSessionId(session, provider, event.sessionId);
        }
        continue;
      }
      if (event.type === "prose") {
        const text = redactSecrets(event.text);
        await this.options.repository.appendProse(run, stage, provider, text);
        panels[provider].text += text;
        await this.options.repository.appendEvent(run, {
          sessionId: session.id,
          runId: run.id,
          stage,
          provider,
          kind: "provider.prose",
          text
        });
      } else if (event.type === "progress") {
        const text = redactSecrets(event.text);
        panels[provider].text += `\n${text}`;
        await this.options.repository.appendEvent(run, {
          sessionId: session.id,
          runId: run.id,
          stage,
          provider,
          kind: "provider.progress",
          text
        });
      } else {
        await this.options.repository.appendDiagnostic(run, stage, provider, {
          text: event.text,
          raw: event.raw
        });
        await this.options.repository.appendEvent(run, {
          sessionId: session.id,
          runId: run.id,
          stage,
          provider,
          kind: "diagnostic",
          text: event.text
        });
      }
      view.update(snapshot);
    }
  }

  private async readEvidence(run: CouncilRun, stage: Stage): Promise<ProviderEvidence> {
    const evidence: ProviderEvidence = {};
    await Promise.all(
      this.enabledProviders.map(async (provider) => {
        if (run.stages[stage].providers[provider].status !== "completed") return;
        const content = await this.options.repository.readArtifact(run, stage, provider);
        if (content !== null) evidence[provider] = content;
      })
    );
    return evidence;
  }
}
