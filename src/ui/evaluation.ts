import wrapAnsi from "wrap-ansi";
import {
  EVALUATION_DIMENSION_IDS,
  type PeerScoreSummary,
  type ResolvedEvaluationResult
} from "../core/evaluation-types.js";
import { EVALUATION_WEIGHTS, rankCandidates } from "../core/evaluation-scoring.js";
import type { ProviderId } from "../core/types.js";

const NAMES: Record<ProviderId, string> = { codex: "Codex", claude: "Claude", copilot: "Copilot" };
const DIMENSIONS = {
  correctness: "Correctness",
  taskFulfillment: "Task Fulfillment",
  evidenceQuality: "Evidence Quality",
  reasoningRigor: "Reasoning Rigor",
  critiqueQuality: "Critique Quality",
  synthesisImprovement: "Synthesis & Improvement",
  clarityActionability: "Clarity & Actionability"
} as const;

function duration(value: number | null): string {
  if (value === null) return "—";
  const seconds = Math.round(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [
    hours > 0 ? `${String(hours)}h` : "",
    minutes > 0 ? `${String(minutes)}m` : "",
    `${String(rest)}s`
  ]
    .filter(Boolean)
    .join(" ");
}

function line(width: number): string {
  return "─".repeat(Math.max(24, Math.min(100, width)));
}
function score(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function relationshipLabel(relationship: "self" | "peer"): "Self" | "Peer" {
  return relationship === "self" ? "Self" : "Peer";
}

function appendTiming(
  lines: string[],
  result: ResolvedEvaluationResult,
  terminalColumns: number
): void {
  const narrow = terminalColumns < 80;
  lines.push(
    "Original Run Execution Time · measured by Council · not included in score",
    line(terminalColumns)
  );
  if (!narrow) {
    lines.push("Agent | Stage 1 Initial | Stage 2 Cross-Review | Stage 3 Final Report | Total");
  }
  for (const provider of result.mapping.map(({ provider }) => provider)) {
    const timing = result.durations[provider];
    if (narrow) {
      lines.push(
        NAMES[provider],
        `  Stage 1 Initial       ${duration(timing.initialMs)}`,
        `  Stage 2 Cross-Review  ${duration(timing.reviewMs)}`,
        `  Stage 3 Final Report  ${duration(timing.finalMs)}`,
        `  Total                 ${duration(timing.totalMs)}`
      );
    } else {
      lines.push(
        `${NAMES[provider]} | ${duration(timing.initialMs)} | ${duration(timing.reviewMs)} | ${duration(timing.finalMs)} | ${duration(timing.totalMs)}`
      );
    }
  }
}

export function renderBlindEvaluation(
  result: ResolvedEvaluationResult,
  sessionLabel: string,
  terminalColumns = 120,
  includeTiming = true
): string {
  const evaluator = NAMES[result.evaluator];
  const rows = rankCandidates(result.candidates);
  const outputWidth = Math.max(24, terminalColumns);
  const narrow = outputWidth < 80;
  const lines: string[] = [
    `Agent Council — Blind Evaluation by ${evaluator}`,
    line(terminalColumns),
    `Session            ${sessionLabel}`,
    `Run                ${result.runId}`,
    `Evaluator          ${evaluator.toUpperCase()} · visible`,
    "Candidates         Anonymous during scoring",
    "Candidate Mapping  Randomized for this evaluator",
    "Execution Time     Withheld from evaluator",
    "Reveal Policy      Identities revealed only after scores were locked",
    "",
    "✓ Blind scores validated",
    "✓ Scores locked",
    "✓ Candidate identities revealed",
    "",
    "Identity Mapping",
    line(outputWidth)
  ];
  if (!narrow) lines.push("Blind ID | Agent | Relationship to Evaluator");
  for (const entry of result.mapping) {
    const candidate = result.candidates.find((item) => item.candidateId === entry.candidateId);
    const relationship = relationshipLabel(candidate?.relationship ?? "peer");
    lines.push(
      narrow
        ? `${entry.candidateId} · ${NAMES[entry.provider]}\n  Relationship to Evaluator  ${relationship}`
        : `${entry.candidateId} | ${NAMES[entry.provider]} | ${relationship}`
    );
  }
  lines.push("", `Scores Assigned by ${evaluator.toUpperCase()}`, line(outputWidth));
  if (!narrow) lines.push("Rank | Blind ID | Agent | Type | Score | Critical Error");
  for (const item of rows) {
    const type = relationshipLabel(item.relationship);
    lines.push(
      narrow
        ? `${item.candidateId} · ${NAMES[item.provider]} · ${type}\n  Rank            ${String(item.rank)}\n  Score           ${item.finalScore.toFixed(1)}\n  Critical Error  ${item.criticalError.present ? "Yes" : "No"}`
        : `${String(item.rank)} | ${item.candidateId} | ${NAMES[item.provider]} | ${type} | ${item.finalScore.toFixed(1)} | ${item.criticalError.present ? "Yes" : "No"}`
    );
    if (item.capApplied)
      lines.push(
        `  Critical-error cap applied to ${item.candidateId}; raw total ${item.rawTotal.toFixed(1)}.`
      );
  }
  lines.push(
    "",
    `Dimension Scores Assigned by ${evaluator.toUpperCase()} · Score: 0–10`,
    line(outputWidth)
  );
  if (narrow) {
    for (const item of rows) {
      lines.push(
        `${NAMES[item.provider]} · ${item.candidateId} · ${relationshipLabel(item.relationship)}`
      );
      for (const dimension of EVALUATION_DIMENSION_IDS) {
        lines.push(
          `  ${DIMENSIONS[dimension]} (${String(EVALUATION_WEIGHTS[dimension])}%)  ${item.dimensions[dimension].score.toFixed(1)}`
        );
      }
      lines.push(`  Weighted Total  ${item.finalScore.toFixed(1)}`, "");
    }
    if (lines.at(-1) === "") lines.pop();
  } else {
    for (const dimension of EVALUATION_DIMENSION_IDS) {
      lines.push(
        `${DIMENSIONS[dimension]} (${String(EVALUATION_WEIGHTS[dimension])}%) | ${result.candidates.map((item) => `${NAMES[item.provider]} (${item.candidateId.slice(-1)}): ${item.dimensions[dimension].score.toFixed(1)}`).join(" | ")}`
      );
    }
    lines.push(
      `Weighted Total | ${result.candidates
        .map((item) => `${NAMES[item.provider]}: ${item.finalScore.toFixed(1)}`)
        .join(" | ")}`
    );
  }
  if (includeTiming) {
    lines.push("");
    appendTiming(lines, result, outputWidth);
  }
  const self = result.candidates.find((item) => item.relationship === "self");
  lines.push("", `All scores above were assigned by ${evaluator.toUpperCase()}.`);
  if (self !== undefined)
    lines.push(
      `${evaluator} → ${NAMES[self.provider]} is a blind self-evaluation revealed after scoring.`
    );
  const peers = result.candidates.filter((item) => item.relationship === "peer");
  if (peers.length > 0) {
    lines.push(
      `${evaluator} → ${peers.map((item) => NAMES[item.provider]).join("/")} ${peers.length === 1 ? "is a peer evaluation" : "are peer evaluations"}.`
    );
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  lines.push("Best-effort blind evaluation; preserved prose may contain identity clues.");
  return wrapAnsi(lines.join("\n"), outputWidth, { hard: true, trim: false });
}

export function renderEvaluationTiming(
  result: ResolvedEvaluationResult,
  terminalColumns = 120
): string {
  const outputWidth = Math.max(24, terminalColumns);
  const lines: string[] = [];
  appendTiming(lines, result, outputWidth);
  return wrapAnsi(lines.join("\n"), outputWidth, {
    hard: true,
    trim: false
  });
}

export function renderPeerScoreSummary(
  summaries: readonly PeerScoreSummary[],
  complete: boolean
): string {
  const lines = [
    "Peer Score Summary",
    complete
      ? "All requested evaluators completed."
      : "Incomplete evaluator set; this is not consensus.",
    "Agent | Self Score | Peer Average | Self–Peer Gap | Peer Rank | Peer Ratings"
  ];
  for (const item of summaries) {
    const rank = item.peerRank === null ? "—" : String(item.peerRank);
    lines.push(
      `${NAMES[item.provider]} | ${score(item.selfScore)} | ${score(item.peerAverage)} | ${item.selfPeerGap === null ? "—" : `${item.selfPeerGap >= 0 ? "+" : ""}${item.selfPeerGap.toFixed(1)}`} | ${rank} | ${String(item.peerRatingCount)}`
    );
  }
  lines.push("Peer averages exclude self-scores. No blended Council score is calculated.");
  return lines.join("\n");
}
