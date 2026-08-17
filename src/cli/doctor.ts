import wrapAnsi from "wrap-ansi";
import {
  PROVIDERS,
  type CouncilConfig,
  type DiagnosticResult,
  type ProviderId
} from "../core/types.js";

type DoctorResult = {
  provider: ProviderId;
  installed: DiagnosticResult;
  authenticated: DiagnosticResult;
};

const DISPLAY_NAMES: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude",
  copilot: "Copilot"
};
const ROW_LABELS = [
  "Status",
  "CLI version",
  "Authentication",
  "Model",
  "Reasoning effort",
  "Permission mode",
  "Remediation"
] as const;
const CELL_SEPARATOR = " | ";
const MINIMUM_TABLE_WIDTH = 72;
const MAXIMUM_TABLE_WIDTH = 180;
const LABEL_WIDTH = Math.max("Dimension".length, ...ROW_LABELS.map((label) => label.length));

function normalizeCell(value: string): string {
  return value.replace(/\s+/gu, " ").trim() || "—";
}

function wrapCell(value: string, width: number): string[] {
  return wrapAnsi(normalizeCell(value), width, { hard: true, trim: true, wordWrap: true }).split(
    "\n"
  );
}

function renderRow(label: string, values: readonly string[], widths: readonly number[]): string[] {
  const cells = values.map((value, index) => wrapCell(value, widths[index] ?? 1));
  const height = Math.max(...cells.map((cell) => cell.length));
  return Array.from({ length: height }, (_, lineIndex) =>
    [
      (lineIndex === 0 ? label : "").padEnd(LABEL_WIDTH),
      ...cells.map((cell, index) => (cell[lineIndex] ?? "").padEnd(widths[index] ?? 1))
    ].join(CELL_SEPARATOR)
  );
}

function providerValues(
  provider: ProviderId,
  config: CouncilConfig,
  result: DoctorResult | undefined
): Record<(typeof ROW_LABELS)[number], string> {
  const enabled = config.enabledProviders.includes(provider);
  const ready = result !== undefined && result.installed.ok && result.authenticated.ok;
  const providerConfig = config.agents[provider];
  return {
    Status: enabled ? (ready ? "ONLINE" : "OFFLINE") : "DISABLED",
    "CLI version": enabled
      ? (result?.installed.version ?? result?.installed.summary ?? "not checked")
      : "not checked",
    Authentication: enabled ? (result?.authenticated.summary ?? "not checked") : "not checked",
    Model: providerConfig.model ?? "provider default",
    "Reasoning effort": providerConfig.effort ?? "provider default",
    "Permission mode": providerConfig.yolo ? "YOLO (permission bypass)" : "safe / approval",
    Remediation:
      !enabled || ready
        ? "—"
        : (result?.authenticated.remediation ??
          result?.installed.remediation ??
          "Check the provider CLI configuration.")
  };
}

export function renderDoctorTable(
  config: CouncilConfig,
  diagnostics: readonly DoctorResult[],
  terminalColumns = 120
): string {
  const width = Math.min(MAXIMUM_TABLE_WIDTH, Math.max(MINIMUM_TABLE_WIDTH, terminalColumns));
  const available = width - LABEL_WIDTH - CELL_SEPARATOR.length * PROVIDERS.length;
  const baseProviderWidth = Math.floor(available / PROVIDERS.length);
  const providerWidths = PROVIDERS.map((_, index) =>
    index === PROVIDERS.length - 1
      ? available - baseProviderWidth * (PROVIDERS.length - 1)
      : baseProviderWidth
  );
  const results = new Map(diagnostics.map((result) => [result.provider, result]));
  const values = Object.fromEntries(
    PROVIDERS.map((provider) => [provider, providerValues(provider, config, results.get(provider))])
  ) as Record<ProviderId, ReturnType<typeof providerValues>>;
  const lines = ["Agent Council Doctor", ""];

  lines.push(
    ...renderRow(
      "Dimension",
      PROVIDERS.map((provider) => DISPLAY_NAMES[provider]),
      providerWidths
    )
  );
  lines.push(
    [
      "-".repeat(LABEL_WIDTH),
      ...providerWidths.map((providerWidth) => "-".repeat(providerWidth))
    ].join("-+-")
  );
  for (const label of ROW_LABELS) {
    lines.push(
      ...renderRow(
        label,
        PROVIDERS.map((provider) => values[provider][label]),
        providerWidths
      )
    );
  }
  return lines.map((line) => line.trimEnd()).join("\n");
}
