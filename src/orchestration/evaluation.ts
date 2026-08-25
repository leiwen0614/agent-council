import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentProcess } from "../providers/index.js";
import { createProviderAdapters } from "../providers/index.js";
import { buildEvaluationRepairPrompt, parseEvaluatorOutput } from "../core/evaluation-output.js";
import { calculateProviderDurations, scoreEvaluatorOutput } from "../core/evaluation-scoring.js";
import type {
  BlindCandidateId,
  BlindEvaluationResult,
  ResolvedEvaluationResult
} from "../core/evaluation-types.js";
import { STAGES, type CouncilRun, type CouncilSession, type ProviderId } from "../core/types.js";
import { CouncilRepository } from "../storage/repository.js";
import { CouncilError, errorMessage } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import { nowIso } from "../util/time.js";
import { CancellationManager } from "./cancellation.js";
import {
  buildBlindEvaluationPrompt,
  createEvaluationMapping,
  type EvaluationEvidence,
  type EvaluationMapping
} from "../core/evaluation-prompts.js";

export type EvaluationSelector = ProviderId | "all";
export type EvaluationTarget = { session: CouncilSession; run: CouncilRun };
export type EvaluationExecution = {
  results: ResolvedEvaluationResult[];
  failures: { evaluator: ProviderId; error: string }[];
};

type LockedEvaluation = {
  evaluator: ProviderId;
  blind: BlindEvaluationResult;
  blindBytes: Buffer;
  mapping: EvaluationMapping;
  warnings: string[];
};

export type BlindEvaluationEngineOptions = {
  repository: CouncilRepository;
  adapters?: Record<ProviderId, AgentAdapter> | undefined;
  temporaryRoot?: string | undefined;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function diagnosticSummary(
  installed: Awaited<ReturnType<AgentAdapter["checkInstalled"]>>,
  authenticated: Awaited<ReturnType<AgentAdapter["checkAuthenticated"]>>
): string {
  return authenticated.remediation ?? installed.remediation ?? authenticated.summary;
}

function candidateIdSet(mapping: EvaluationMapping): BlindCandidateId[] {
  return mapping.map(({ candidateId }) => candidateId);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function existingEvaluationMatches(
  run: CouncilRun,
  evaluator: ProviderId,
  blind: BlindEvaluationResult,
  resolved: ResolvedEvaluationResult,
  blindBytes: Buffer
): boolean {
  if (
    blind.evaluator !== evaluator ||
    resolved.evaluator !== evaluator ||
    resolved.sessionId !== run.sessionId ||
    resolved.runId !== run.id ||
    resolved.model !== run.effectiveConfig.agents[evaluator].model ||
    resolved.effort !== run.effectiveConfig.agents[evaluator].effort ||
    resolved.scoresLockedAt !== blind.scoresLockedAt ||
    resolved.blindResultSha256 !== sha256(blindBytes) ||
    !sameJson(resolved.durations, calculateProviderDurations(run))
  ) {
    return false;
  }
  const targetProviders = new Set(run.effectiveConfig.enabledProviders);
  const mappedProviders = new Set(resolved.mapping.map(({ provider }) => provider));
  if (
    mappedProviders.size !== targetProviders.size ||
    [...targetProviders].some((provider) => !mappedProviders.has(provider)) ||
    !sameJson(
      [...resolved.mapping].map(({ candidateId }) => candidateId).sort(),
      [...blind.candidateIds].sort()
    )
  ) {
    return false;
  }
  const blindByCandidate = new Map(
    blind.candidates.map((candidate) => [candidate.candidateId, candidate])
  );
  return resolved.candidates.every((candidate) => {
    const blindCandidate = blindByCandidate.get(candidate.candidateId);
    if (blindCandidate === undefined) return false;
    const { provider, relationship, ...blindFields } = candidate;
    const expectedRelationship = provider === evaluator ? "self" : "peer";
    return relationship === expectedRelationship && sameJson(blindFields, blindCandidate);
  });
}

export class BlindEvaluationEngine {
  private readonly adapters: Record<ProviderId, AgentAdapter>;
  private readonly cancellation = new CancellationManager();

  constructor(private readonly options: BlindEvaluationEngineOptions) {
    this.adapters = options.adapters ?? createProviderAdapters();
  }

  async resolveTarget(sessionSelector?: string, runId?: string): Promise<EvaluationTarget> {
    if (runId !== undefined && sessionSelector === undefined) {
      throw new CouncilError(
        "BLIND_EVAL_RUN_NOT_FOUND",
        "--run requires a Council session ID or name."
      );
    }
    if (sessionSelector !== undefined) {
      const session = await this.options.repository.resolveSession(sessionSelector);
      if (runId !== undefined) {
        const run = await this.options.repository.findRun(session.id, runId);
        await this.assertEligible(run);
        return { session, run };
      }
      for (const run of await this.options.repository.listRuns(session.id)) {
        if (await this.isEligible(run)) return { session, run };
      }
      throw new CouncilError(
        "BLIND_EVAL_RUN_NOT_FOUND",
        `No eligible run exists in session ${session.name ?? session.id}.`
      );
    }

    const eligible: EvaluationTarget[] = [];
    for (const session of await this.options.repository.listSessions()) {
      for (const run of await this.options.repository.listRuns(session.id)) {
        if (await this.isEligible(run)) eligible.push({ session, run });
      }
    }
    eligible.sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt));
    const target = eligible[0];
    if (target === undefined) {
      throw new CouncilError(
        "BLIND_EVAL_RUN_NOT_FOUND",
        "No eligible completed Council run exists in the current project."
      );
    }
    return target;
  }

  async execute(
    target: EvaluationTarget,
    selector: EvaluationSelector
  ): Promise<EvaluationExecution> {
    await this.assertEligible(target.run);
    const evaluators =
      selector === "all" ? target.run.effectiveConfig.enabledProviders : [selector];
    const results: ResolvedEvaluationResult[] = [];
    const missing: ProviderId[] = [];
    for (const evaluator of evaluators) {
      const existing = await this.options.repository.loadResolvedEvaluation(target.run, evaluator);
      const blind = await this.options.repository.loadBlindEvaluation(target.run, evaluator);
      if (existing !== null || blind !== null) {
        if (existing === null || blind === null) {
          throw new CouncilError(
            "BLIND_EVAL_EXISTING_INVALID",
            `Run ${target.run.id} has an incomplete existing evaluation from ${evaluator}; rerun is unsafe.`
          );
        }
        const blindBytes = await this.options.repository.readLockedEvaluationBytes(
          target.run,
          evaluator
        );
        const storedPrompt = await this.options.repository.readEvaluationPrompt(
          target.run,
          evaluator
        );
        if (
          storedPrompt === null ||
          blind.inputSha256 !== sha256(storedPrompt) ||
          !existingEvaluationMatches(target.run, evaluator, blind, existing, blindBytes)
        ) {
          throw new CouncilError(
            "BLIND_EVAL_EXISTING_INVALID",
            `The existing evaluation from ${evaluator} does not match its locked blind record.`
          );
        }
        results.push(existing);
      } else {
        missing.push(evaluator);
      }
    }

    const readiness = await Promise.all(
      missing.map(async (evaluator) => {
        const installed = await this.adapters[evaluator].checkInstalled();
        const authenticated = installed.ok
          ? await this.adapters[evaluator].checkAuthenticated()
          : {
              ok: false,
              summary: "Authentication was not checked.",
              remediation: installed.remediation
            };
        return { evaluator, installed, authenticated };
      })
    );
    const failures = readiness
      .filter(({ installed, authenticated }) => !installed.ok || !authenticated.ok)
      .map(({ evaluator, installed, authenticated }) => ({
        evaluator,
        error: diagnosticSummary(installed, authenticated)
      }));
    const ready = readiness
      .filter(({ installed, authenticated }) => installed.ok && authenticated.ok)
      .map(({ evaluator }) => evaluator);
    if (selector !== "all" && failures.length > 0) {
      const failure = failures[0];
      throw new CouncilError(
        "BLIND_EVAL_EVALUATOR_UNAVAILABLE",
        `${failure?.evaluator ?? selector} cannot evaluate run ${target.run.id}: ${failure?.error ?? "unavailable"}`
      );
    }

    const evidence = ready.length === 0 ? null : await this.readEvidence(target.run);
    this.cancellation.install(() =>
      process.stderr.write(
        "\nCancelling blind evaluators gracefully. Press Ctrl+C again to force termination.\n"
      )
    );
    try {
      const locked =
        evidence === null
          ? []
          : await Promise.allSettled(
              ready.map((evaluator) => this.evaluateAndLock(target.run, evaluator, evidence))
            );
      const successful: LockedEvaluation[] = [];
      locked.forEach((outcome, index) => {
        const evaluator = ready[index];
        if (evaluator === undefined) return;
        if (outcome.status === "fulfilled") successful.push(outcome.value);
        else failures.push({ evaluator, error: redactSecrets(errorMessage(outcome.reason)) });
      });

      // The reveal barrier is here: every launched evaluator has locked or reached terminal failure.
      for (const item of successful) {
        try {
          const resolved = await this.reveal(target.run, item);
          results.push(resolved);
        } catch (error) {
          failures.push({ evaluator: item.evaluator, error: redactSecrets(errorMessage(error)) });
        }
      }
    } finally {
      this.cancellation.uninstall();
    }
    return { results, failures };
  }

  async assertEligible(run: CouncilRun): Promise<void> {
    if (!(await this.isEligible(run))) {
      throw new CouncilError(
        "BLIND_EVAL_RUN_INELIGIBLE",
        `Run ${run.id} is not a complete three-stage run. Blind evaluation currently requires every effective provider to have completed Initial Answer, Anonymous Cross-Review, and Final Report.`
      );
    }
  }

  private async isEligible(run: CouncilRun): Promise<boolean> {
    const providers = run.effectiveConfig.enabledProviders;
    if (
      !["awaiting_decision", "completed"].includes(run.status) ||
      run.degraded ||
      run.degradedContinuations.length > 0 ||
      providers.length < 2 ||
      STAGES.some((stage) => run.stages[stage].status !== "completed")
    )
      return false;
    try {
      if ((await this.options.repository.readPrompt(run)).trim().length === 0) return false;
    } catch {
      return false;
    }
    for (const provider of providers) {
      for (const stage of STAGES) {
        if (run.stages[stage].providers[provider].status !== "completed") return false;
        const artifact = await this.options.repository.readArtifact(run, stage, provider);
        if (artifact === null || artifact.trim().length === 0) return false;
      }
      const mapping = run.reviewMappings[provider];
      if (mapping?.labels.length !== providers.length - 1) return false;
      const expectedPeers = providers.filter((candidate) => candidate !== provider);
      const expectedLabels = new Set(
        expectedPeers.map((_, index) => `Answer ${String.fromCharCode(65 + index)}`)
      );
      const labels = new Set(mapping.labels.map(({ label }) => label));
      const mappedPeers = new Set(mapping.labels.map(({ provider: peer }) => peer));
      const displayLabels = new Set(mapping.displayOrder);
      if (
        labels.size !== mapping.labels.length ||
        labels.size !== expectedLabels.size ||
        [...expectedLabels].some((label) => !labels.has(label)) ||
        mappedPeers.size !== expectedPeers.length ||
        expectedPeers.some((peer) => !mappedPeers.has(peer)) ||
        mappedPeers.has(provider) ||
        mapping.displayOrder.length !== labels.size ||
        displayLabels.size !== labels.size ||
        [...labels].some((label) => !displayLabels.has(label))
      ) {
        return false;
      }
    }
    return true;
  }

  private async readEvidence(run: CouncilRun): Promise<EvaluationEvidence> {
    const providers = run.effectiveConfig.enabledProviders;
    const initialAnswers: Partial<Record<ProviderId, string>> = {};
    const reviews: Partial<Record<ProviderId, string>> = {};
    const finals: Partial<Record<ProviderId, string>> = {};
    await Promise.all(
      providers.flatMap((provider) =>
        STAGES.map(async (stage) => {
          const content = await this.options.repository.readArtifact(run, stage, provider);
          if (content === null || content.trim().length === 0) {
            throw new CouncilError(
              "BLIND_EVAL_RUN_INELIGIBLE",
              `Missing ${stage} evidence for ${provider}.`
            );
          }
          if (stage === "initial") initialAnswers[provider] = content;
          else if (stage === "review") reviews[provider] = content;
          else finals[provider] = content;
        })
      )
    );
    return {
      originalPrompt: await this.options.repository.readPrompt(run),
      providers,
      initialAnswers,
      reviews,
      finals,
      reviewMappings: run.reviewMappings
    };
  }

  private async evaluateAndLock(
    run: CouncilRun,
    evaluator: ProviderId,
    evidence: EvaluationEvidence
  ): Promise<LockedEvaluation> {
    const mappingPackage = createEvaluationMapping(evidence.providers);
    const built = buildBlindEvaluationPrompt({ ...evidence, ...mappingPackage });
    await this.options.repository.writeEvaluationPrompt(run, evaluator, built.prompt);
    const inputSha256 = sha256(built.prompt);
    const candidateIds = candidateIdSet(mappingPackage.mapping);
    let output: ReturnType<typeof parseEvaluatorOutput>;
    try {
      const first = await this.invoke(run, evaluator, built.prompt, false);
      try {
        output = parseEvaluatorOutput(first, candidateIds);
      } catch (error) {
        this.throwIfCancelled(evaluator);
        const repaired = await this.invoke(
          run,
          evaluator,
          buildEvaluationRepairPrompt(built.prompt, first, errorMessage(error)),
          true
        );
        output = parseEvaluatorOutput(repaired, candidateIds);
      }
      this.throwIfCancelled(evaluator);
    } catch (error) {
      if (this.cancellation.cancelled) {
        throw new CouncilError(
          "BLIND_EVAL_CANCELLED",
          `Blind evaluation by ${evaluator} was cancelled.`,
          { cause: error }
        );
      }
      throw error;
    }
    const blind: BlindEvaluationResult = {
      schemaVersion: 1,
      evaluator,
      candidateIds,
      inputSha256,
      scoresLockedAt: nowIso(),
      candidates: scoreEvaluatorOutput(output)
    };
    const blindBytes = await this.options.repository.lockBlindEvaluation(run, blind);
    return {
      evaluator,
      blind,
      blindBytes,
      mapping: mappingPackage.mapping,
      warnings: built.warnings
    };
  }

  private async invoke(
    run: CouncilRun,
    evaluator: ProviderId,
    prompt: string,
    repair: boolean
  ): Promise<string> {
    this.throwIfCancelled(evaluator);
    const prefix = join(this.options.temporaryRoot ?? tmpdir(), "agent-council-blind-eval-");
    const cwd = await mkdtemp(prefix);
    const promptPath = join(cwd, repair ? "repair.md" : "evaluation.md");
    let removeProcess: (() => void) | null = null;
    try {
      await writeFile(promptPath, prompt, "utf8");
      this.throwIfCancelled(evaluator);
      const settings = run.effectiveConfig.agents[evaluator];
      const processHandle: AgentProcess = this.adapters[evaluator].start({
        prompt,
        cwd,
        allowNonGitWorkingDirectory: true,
        yolo: false,
        model: settings.model,
        effort: settings.effort,
        promptPath: evaluator === "copilot" ? promptPath : undefined
      });
      removeProcess = this.cancellation.add(processHandle);
      let prose = "";
      const consume = (async () => {
        for await (const event of processHandle.events) {
          if (this.cancellation.cancelled) break;
          if (event.type === "prose") prose += event.text;
          else if (event.type === "diagnostic") {
            await this.options.repository.appendEvaluationDiagnostic(run, evaluator, {
              phase: repair ? "repair" : "evaluation",
              text: event.text
            });
          }
        }
      })();
      const result = await processHandle.completion;
      await consume;
      removeProcess();
      removeProcess = null;
      if (result.cancelled)
        throw new CouncilError("BLIND_EVAL_CANCELLED", `Evaluation by ${evaluator} was cancelled.`);
      if (result.exitCode !== 0) {
        throw new CouncilError(
          "BLIND_EVAL_OUTPUT_INVALID",
          `${evaluator} evaluation failed: ${redactSecrets(result.error ?? "provider process failed")}`
        );
      }
      if (prose.trim().length === 0) {
        throw new CouncilError(
          "BLIND_EVAL_OUTPUT_INVALID",
          `${evaluator} returned no structured evaluation.`
        );
      }
      return prose;
    } finally {
      removeProcess?.();
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private throwIfCancelled(evaluator: ProviderId): void {
    if (this.cancellation.cancelled) {
      throw new CouncilError(
        "BLIND_EVAL_CANCELLED",
        `Blind evaluation by ${evaluator} was cancelled.`
      );
    }
  }

  private async reveal(
    run: CouncilRun,
    locked: LockedEvaluation
  ): Promise<ResolvedEvaluationResult> {
    const providerByCandidate = new Map(
      locked.mapping.map(({ candidateId, provider }) => [candidateId, provider])
    );
    const result: ResolvedEvaluationResult = {
      schemaVersion: 1,
      evaluator: locked.evaluator,
      sessionId: run.sessionId,
      runId: run.id,
      status: "completed",
      model: run.effectiveConfig.agents[locked.evaluator].model,
      effort: run.effectiveConfig.agents[locked.evaluator].effort,
      blindness: {
        bestEffort: true,
        freshSession: true,
        isolatedWorkingDirectory: true,
        timingWithheld: true,
        identitiesRevealedAfterLock: true
      },
      mapping: locked.mapping,
      candidates: locked.blind.candidates.map((candidate) => {
        const provider = providerByCandidate.get(candidate.candidateId);
        if (provider === undefined)
          throw new CouncilError("BLIND_EVAL_MAPPING_INVALID", "Candidate mapping is incomplete.");
        return {
          ...candidate,
          provider,
          relationship: provider === locked.evaluator ? "self" : "peer"
        };
      }),
      blindResultSha256: sha256(locked.blindBytes),
      durations: calculateProviderDurations(run),
      scoresLockedAt: locked.blind.scoresLockedAt,
      identitiesRevealedAt: nowIso(),
      warnings: locked.warnings
    };
    await this.options.repository.saveResolvedEvaluation(run, result);
    return result;
  }
}
