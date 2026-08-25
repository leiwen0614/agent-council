import stringWidth from "string-width";
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

const MIN_OUTPUT_WIDTH = 24;
const MAX_OUTPUT_WIDTH = 140;
const WIDE_GRID_WIDTH = 100;

type GridRow = readonly string[];

function outputWidth(terminalColumns: number): number {
  return Math.max(MIN_OUTPUT_WIDTH, Math.min(MAX_OUTPUT_WIDTH, terminalColumns));
}

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

function score(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function signedScore(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function relationshipLabel(relationship: "self" | "peer"): "Self" | "Peer" {
  return relationship === "self" ? "Self" : "Peer";
}

function longestLineWidth(value: string): number {
  return Math.max(1, ...value.split("\n").map((line) => stringWidth(line)));
}

function allocateColumnWidths(headers: GridRow, rows: readonly GridRow[], width: number): number[] {
  const columnCount = headers.length;
  const contentBudget = width - (3 * columnCount + 1);
  if (contentBudget < columnCount) {
    throw new Error(`A ${String(columnCount)}-column grid cannot fit in ${String(width)} columns.`);
  }
  const naturalWidths = headers.map((header, column) =>
    Math.max(longestLineWidth(header), ...rows.map((row) => longestLineWidth(row[column] ?? "")))
  );
  const widths = naturalWidths.slice();
  let used = widths.reduce((total, value) => total + value, 0);

  while (used > contentBudget) {
    let widest = -1;
    for (let column = 0; column < widths.length; column += 1) {
      if ((widths[column] ?? 0) <= 1) continue;
      if (widest === -1 || (widths[column] ?? 0) > (widths[widest] ?? 0)) widest = column;
    }
    if (widest === -1) break;
    widths[widest] = (widths[widest] ?? 1) - 1;
    used -= 1;
  }

  let column = 0;
  while (used < contentBudget) {
    widths[column] = (widths[column] ?? 0) + 1;
    used += 1;
    column = (column + 1) % columnCount;
  }
  return widths;
}

function wrapCell(value: string, width: number): string[] {
  return value.split("\n").flatMap((line) => {
    if (line.length === 0) return [""];
    return wrapAnsi(line, width, { hard: true, trim: false }).split("\n");
  });
}

function padCell(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - stringWidth(value)))}`;
}

function columnBorder(
  widths: readonly number[],
  left: string,
  middle: string,
  right: string
): string {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
}

function renderGridRow(row: GridRow, widths: readonly number[]): string[] {
  const cells = widths.map((width, column) => wrapCell(row[column] ?? "", width));
  const height = Math.max(...cells.map((cell) => cell.length));
  return Array.from(
    { length: height },
    (_, line) =>
      `│${cells
        .map((cell, column) => ` ${padCell(cell[line] ?? "", widths[column] ?? 1)} `)
        .join("│")}│`
  );
}

/** Render a section as one bounded grid, including its title and every supplied value. */
function renderGrid(
  title: string,
  headers: GridRow,
  rows: readonly GridRow[],
  width: number
): string {
  if (headers.length === 0 || rows.some((row) => row.length !== headers.length)) {
    throw new Error("Grid rows must match the non-empty header column count.");
  }

  const widths = allocateColumnWidths(headers, rows, width);
  const titleWidth = width - 4;
  const lines = [
    `┌${"─".repeat(width - 2)}┐`,
    ...wrapCell(title, titleWidth).map((line) => `│ ${padCell(line, titleWidth)} │`),
    columnBorder(widths, "├", "┬", "┤"),
    ...renderGridRow(headers, widths),
    columnBorder(widths, "├", "┼", "┤")
  ];

  rows.forEach((row, index) => {
    lines.push(...renderGridRow(row, widths));
    lines.push(
      index === rows.length - 1
        ? columnBorder(widths, "└", "┴", "┘")
        : columnBorder(widths, "├", "┼", "┤")
    );
  });
  return lines.join("\n");
}

function keyValueGrid(
  title: string,
  rows: readonly (readonly [string, string])[],
  width: number
): string {
  return renderGrid(title, ["Field", "Value"], rows, width);
}

function renderIdentityGrids(result: ResolvedEvaluationResult, width: number): string[] {
  if (width >= WIDE_GRID_WIDTH) {
    return [
      renderGrid(
        "Identity Mapping",
        ["Blind ID", "Agent", "Relationship to Evaluator"],
        result.mapping.map((entry) => {
          const candidate = result.candidates.find(
            (item) => item.candidateId === entry.candidateId
          );
          return [
            entry.candidateId,
            NAMES[entry.provider],
            relationshipLabel(candidate?.relationship ?? "peer")
          ];
        }),
        width
      )
    ];
  }

  return result.mapping.map((entry) => {
    const candidate = result.candidates.find((item) => item.candidateId === entry.candidateId);
    return keyValueGrid(
      `Identity Mapping · ${entry.candidateId}`,
      [
        ["Blind ID", entry.candidateId],
        ["Agent", NAMES[entry.provider]],
        ["Relationship to Evaluator", relationshipLabel(candidate?.relationship ?? "peer")]
      ],
      width
    );
  });
}

function renderScoreGrids(result: ResolvedEvaluationResult, width: number): string[] {
  const evaluator = NAMES[result.evaluator].toUpperCase();
  const rows = rankCandidates(result.candidates);
  if (width >= WIDE_GRID_WIDTH) {
    return [
      renderGrid(
        `Scores Assigned by ${evaluator}`,
        [
          "Rank",
          "Blind ID",
          "Agent",
          "Relationship",
          "Raw Score",
          "Final Score",
          "Critical Error",
          "Cap Applied"
        ],
        rows.map((item) => [
          String(item.rank),
          item.candidateId,
          NAMES[item.provider],
          relationshipLabel(item.relationship),
          item.rawTotal.toFixed(1),
          item.finalScore.toFixed(1),
          item.criticalError.present ? "Yes" : "No",
          item.capApplied ? "Yes" : "No"
        ]),
        width
      )
    ];
  }

  return rows.map((item) =>
    keyValueGrid(
      `Scores Assigned by ${evaluator} · ${item.candidateId}`,
      [
        ["Blind ID", item.candidateId],
        ["Agent", NAMES[item.provider]],
        ["Relationship to Evaluator", relationshipLabel(item.relationship)],
        ["Rank", String(item.rank)],
        ["Raw Score", item.rawTotal.toFixed(1)],
        ["Final Score", item.finalScore.toFixed(1)],
        ["Critical Error", item.criticalError.present ? "Yes" : "No"],
        ["Cap Applied", item.capApplied ? "Yes" : "No"]
      ],
      width
    )
  );
}

function renderDimensionGrids(result: ResolvedEvaluationResult, width: number): string[] {
  const evaluator = NAMES[result.evaluator].toUpperCase();
  const candidates = rankCandidates(result.candidates);
  if (width >= WIDE_GRID_WIDTH) {
    return [
      renderGrid(
        `Dimension Scores Assigned by ${evaluator} · Score: 0–10`,
        [
          "Dimension",
          "Weight",
          ...candidates.map(
            (item) =>
              `${item.candidateId}\n${NAMES[item.provider]} · ${relationshipLabel(item.relationship)}`
          )
        ],
        [
          ...EVALUATION_DIMENSION_IDS.map((dimension) => [
            DIMENSIONS[dimension],
            `${String(EVALUATION_WEIGHTS[dimension])}%`,
            ...candidates.map((item) => item.dimensions[dimension].score.toFixed(1))
          ]),
          ["Weighted Total", "100%", ...candidates.map((item) => item.finalScore.toFixed(1))]
        ],
        width
      )
    ];
  }

  return candidates.map((item) =>
    renderGrid(
      `Dimension Scores Assigned by ${evaluator} · ${item.candidateId} · ${NAMES[item.provider]} · ${relationshipLabel(item.relationship)} · Score: 0–10`,
      ["Dimension", "Weight", "Score"],
      [
        ...EVALUATION_DIMENSION_IDS.map((dimension) => [
          DIMENSIONS[dimension],
          `${String(EVALUATION_WEIGHTS[dimension])}%`,
          item.dimensions[dimension].score.toFixed(1)
        ]),
        ["Weighted Total", "100%", item.finalScore.toFixed(1)]
      ],
      width
    )
  );
}

function renderTimingGrids(result: ResolvedEvaluationResult, width: number): string[] {
  const title = "Original Run Execution Time · measured by Council · not included in score";
  const providers = result.mapping.map(({ provider }) => provider);
  if (width >= WIDE_GRID_WIDTH) {
    return [
      renderGrid(
        title,
        ["Agent", "Stage 1 Initial", "Stage 2 Cross-Review", "Stage 3 Final Report", "Total"],
        providers.map((provider) => {
          const timing = result.durations[provider];
          return [
            NAMES[provider],
            duration(timing.initialMs),
            duration(timing.reviewMs),
            duration(timing.finalMs),
            duration(timing.totalMs)
          ];
        }),
        width
      )
    ];
  }

  return providers.map((provider) => {
    const timing = result.durations[provider];
    return keyValueGrid(
      `${title} · ${NAMES[provider]}`,
      [
        ["Agent", NAMES[provider]],
        ["Stage 1 Initial", duration(timing.initialMs)],
        ["Stage 2 Cross-Review", duration(timing.reviewMs)],
        ["Stage 3 Final Report", duration(timing.finalMs)],
        ["Total", duration(timing.totalMs)]
      ],
      width
    );
  });
}

function renderNotesGrid(result: ResolvedEvaluationResult, width: number): string {
  const evaluator = NAMES[result.evaluator];
  const self = result.candidates.find((item) => item.relationship === "self");
  const peers = result.candidates.filter((item) => item.relationship === "peer");
  const rows: [string, string][] = [
    ["Evaluator Provenance", `All scores above were assigned by ${evaluator.toUpperCase()}.`]
  ];
  if (self !== undefined) {
    rows.push([
      "Self Evaluation",
      `${evaluator} → ${NAMES[self.provider]} is a blind self-evaluation revealed after scoring.`
    ]);
  }
  if (peers.length > 0) {
    rows.push([
      "Peer Evaluation",
      `${evaluator} → ${peers.map((item) => NAMES[item.provider]).join("/")} ${peers.length === 1 ? "is a peer evaluation" : "are peer evaluations"}.`
    ]);
  }
  result.warnings.forEach((warning, index) => rows.push([`Warning ${String(index + 1)}`, warning]));
  rows.push([
    "Blindness",
    "Best-effort blind evaluation; preserved prose may contain identity clues."
  ]);
  return keyValueGrid("Evaluation Notes", rows, width);
}

export function renderBlindEvaluation(
  result: ResolvedEvaluationResult,
  sessionLabel: string,
  terminalColumns = 120,
  includeTiming = true
): string {
  const width = outputWidth(terminalColumns);
  const evaluator = NAMES[result.evaluator];
  const sections = [
    keyValueGrid(
      `Agent Council — Blind Evaluation by ${evaluator}`,
      [
        ["Session", sessionLabel],
        ["Run", result.runId],
        ["Evaluator", `${evaluator.toUpperCase()} · visible`],
        ["Candidates", "Anonymous during scoring"],
        ["Candidate Mapping", "Randomized for this evaluator"],
        ["Execution Time", "Withheld from evaluator"],
        ["Reveal Policy", "Identities revealed only after scores were locked"],
        ["Blind Scores", "✓ Blind scores validated"],
        ["Score Lock", "✓ Scores locked"],
        ["Identity Reveal", "✓ Candidate identities revealed"]
      ],
      width
    ),
    ...renderIdentityGrids(result, width),
    ...renderScoreGrids(result, width),
    ...renderDimensionGrids(result, width)
  ];
  if (includeTiming) sections.push(...renderTimingGrids(result, width));
  sections.push(renderNotesGrid(result, width));
  return sections.join("\n\n");
}

export function renderEvaluationStart(
  sessionLabel: string,
  runId: string,
  evaluator: ProviderId | "all",
  terminalColumns = 120
): string {
  const width = outputWidth(terminalColumns);
  const evaluatorLabel = evaluator === "all" ? "All participating providers" : NAMES[evaluator];
  return keyValueGrid(
    "Agent Council — Blind Evaluation by " + evaluatorLabel,
    [
      ["Session", sessionLabel],
      ["Run", runId],
      ["Evaluator", evaluatorLabel],
      ["Candidate Identity", "Hidden while scoring"],
      ["Execution Time", "Withheld from evaluators"],
      ["Status", "Evaluating all anonymous candidate bundles"]
    ],
    width
  );
}

export function renderEvaluationTiming(
  result: ResolvedEvaluationResult,
  terminalColumns = 120
): string {
  return renderTimingGrids(result, outputWidth(terminalColumns)).join("\n\n");
}

export function renderEvaluationFailures(
  failures: readonly { evaluator: ProviderId; error: string }[],
  terminalColumns = 120
): string {
  const width = outputWidth(terminalColumns);
  return renderGrid(
    "Blind Evaluation Failures",
    ["Evaluator", "Status", "Detail"],
    failures.map((failure) => [NAMES[failure.evaluator], "Failed", failure.error]),
    width
  );
}

export function renderPeerScoreSummary(
  summaries: readonly PeerScoreSummary[],
  complete: boolean,
  terminalColumns = 120
): string {
  const width = outputWidth(terminalColumns);
  const sections = [
    keyValueGrid(
      "Peer Score Summary",
      [
        [
          "Evaluator Set",
          complete
            ? "All requested evaluators completed."
            : "Incomplete evaluator set; this is not consensus."
        ],
        [
          "Calculation",
          "Peer averages exclude self-scores. No blended Council score is calculated."
        ]
      ],
      width
    )
  ];

  if (width >= WIDE_GRID_WIDTH) {
    sections.push(
      renderGrid(
        "Peer Score Details",
        ["Agent", "Self Score", "Peer Average", "Self–Peer Gap", "Peer Rank", "Peer Ratings"],
        summaries.map((item) => [
          NAMES[item.provider],
          score(item.selfScore),
          score(item.peerAverage),
          signedScore(item.selfPeerGap),
          item.peerRank === null ? "—" : String(item.peerRank),
          String(item.peerRatingCount)
        ]),
        width
      )
    );
  } else {
    sections.push(
      ...summaries.map((item) =>
        keyValueGrid(
          `Peer Score Details · ${NAMES[item.provider]}`,
          [
            ["Agent", NAMES[item.provider]],
            ["Self Score", score(item.selfScore)],
            ["Peer Average", score(item.peerAverage)],
            ["Self–Peer Gap", signedScore(item.selfPeerGap)],
            ["Peer Rank", item.peerRank === null ? "—" : String(item.peerRank)],
            ["Peer Ratings", String(item.peerRatingCount)]
          ],
          width
        )
      )
    );
  }
  return sections.join("\n\n");
}
