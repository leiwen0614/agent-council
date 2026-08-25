import { dirname, join, relative } from "node:path";
import type { ProviderId, Stage } from "../core/types.js";

const STAGE_DIRECTORIES: Record<Stage, string> = {
  initial: "answers",
  review: "reviews",
  final: "finals"
};

export class CouncilPaths {
  readonly projectRoot: string;
  readonly councilRoot: string;
  readonly sessionsRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.councilRoot = join(projectRoot, ".council");
    this.sessionsRoot = join(this.councilRoot, "sessions");
  }

  sessionRoot(sessionId: string): string {
    return join(this.sessionsRoot, sessionId);
  }

  sessionJson(sessionId: string): string {
    return join(this.sessionRoot(sessionId), "session.json");
  }

  runsRoot(sessionId: string): string {
    return join(this.sessionRoot(sessionId), "runs");
  }

  runRoot(sessionId: string, runId: string): string {
    return join(this.runsRoot(sessionId), runId);
  }

  runJson(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "run.json");
  }

  events(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "events.jsonl");
  }

  prompt(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "prompt.md");
  }

  decision(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "decision.json");
  }

  finalExport(sessionId: string, runId: string): string {
    return join(this.runRoot(sessionId, runId), "final.md");
  }

  artifact(sessionId: string, runId: string, stage: Stage, provider: ProviderId): string {
    return join(this.runRoot(sessionId, runId), STAGE_DIRECTORIES[stage], `${provider}.md`);
  }

  partialArtifact(sessionId: string, runId: string, stage: Stage, provider: ProviderId): string {
    return `${this.artifact(sessionId, runId, stage, provider)}.partial`;
  }

  attemptPartial(
    sessionId: string,
    runId: string,
    stage: Stage,
    provider: ProviderId,
    attempt: number
  ): string {
    return join(
      dirname(this.artifact(sessionId, runId, stage, provider)),
      `${provider}.attempt-${String(attempt)}.md.partial`
    );
  }

  stagePrompt(sessionId: string, runId: string, stage: Stage, provider: ProviderId): string {
    return join(this.runRoot(sessionId, runId), "prompts", stage, `${provider}.md`);
  }

  diagnostic(sessionId: string, runId: string, stage: Stage, provider: ProviderId): string {
    return join(this.runRoot(sessionId, runId), "diagnostics", `${stage}-${provider}.jsonl`);
  }

  evaluationPrompt(sessionId: string, runId: string, evaluator: ProviderId): string {
    return join(this.runRoot(sessionId, runId), "prompts", "evaluation", `${evaluator}.md`);
  }

  blindEvaluation(sessionId: string, runId: string, evaluator: ProviderId): string {
    return join(this.runRoot(sessionId, runId), "evaluations", `${evaluator}.blind.json`);
  }

  resolvedEvaluation(sessionId: string, runId: string, evaluator: ProviderId): string {
    return join(this.runRoot(sessionId, runId), "evaluations", `${evaluator}.json`);
  }

  evaluationDiagnostic(sessionId: string, runId: string, evaluator: ProviderId): string {
    return join(this.runRoot(sessionId, runId), "diagnostics", `evaluation-${evaluator}.jsonl`);
  }

  projectRelative(path: string): string {
    return relative(this.projectRoot, path).split("\\").join("/");
  }
}
