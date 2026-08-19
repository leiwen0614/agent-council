import React, { useEffect, useState } from "react";
import {
  Box,
  Text,
  render,
  renderToString,
  useStdout,
  type Instance,
  type RenderOptions
} from "ink";
import wrapAnsi from "wrap-ansi";
import type { ProviderId, ProviderStatus, Stage } from "../core/types.js";

export type LivePanelState = { status: ProviderStatus; text: string };

export type LiveSnapshot = {
  providers: ProviderId[];
  sessionLabel: string;
  runId: string;
  stage: Stage;
  startedAt: number;
  panels: Record<ProviderId, LivePanelState>;
};

export type LiveView = {
  update(snapshot: LiveSnapshot): void;
  close(options?: { preserveCompleteOutput?: boolean }): Promise<void>;
};

export type LiveViewStreams = {
  stdout: NodeJS.WriteStream;
};

const DISPLAY_NAMES: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude",
  copilot: "Copilot"
};
const STAGE_NAMES: Record<Stage, string> = {
  initial: "Initial Answer",
  review: "Anonymous Cross-Review",
  final: "Final Report"
};
const STAGE_NUMBER: Record<Stage, number> = { initial: 1, review: 2, final: 3 };
const HORIZONTAL_MINIMUM_COLUMNS = 100;
const PANEL_CHROME_COLUMNS = 4; // Two border and two horizontal-padding columns.
const WAITING_TEXT = "Waiting for output…";
const DEFAULT_TERMINAL_ROWS = 24;

export const LIVE_RENDER_OPTIONS = {
  exitOnCtrlC: false,
  incrementalRendering: false,
  maxFps: 30,
  patchConsole: false
} satisfies Omit<RenderOptions, "stdout">;

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const values = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return values.map((value) => String(value).padStart(2, "0")).join(":");
}

export function panelContentWidth(
  terminalColumns: number,
  providerCount: number,
  horizontal = terminalColumns >= HORIZONTAL_MINIMUM_COLUMNS
): number {
  const count = Math.max(1, providerCount);
  const available = Math.max(1, terminalColumns);
  const panelWidth = horizontal ? Math.floor((available - (count - 1)) / count) : available;
  return Math.max(1, panelWidth - PANEL_CHROME_COLUMNS);
}

export function outputDisplayRows(text: string, width: number): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
  if (normalized.length === 0) return [WAITING_TEXT];

  return normalized.split("\n").flatMap((line) =>
    wrapAnsi(line, Math.max(1, width), {
      hard: true,
      trim: false,
      wordWrap: false
    }).split("\n")
  );
}

export function commonPanelOutputHeight(
  rowGroups: readonly (readonly string[])[],
  horizontal: boolean
): number | undefined {
  if (!horizontal) return undefined;
  return rowGroups.reduce((maximum, rows) => Math.max(maximum, rows.length), 0);
}

export function livePreviewRows(
  terminalRows: number,
  providerCount: number,
  horizontal: boolean
): number {
  const rows = Math.max(1, terminalRows);
  const count = Math.max(1, providerCount);
  const chromeRows = horizontal ? 10 : 5 * count + 6;
  const available = rows - chromeRows;
  if (available <= 0) return 0;
  return horizontal ? available : Math.max(1, Math.floor(available / count));
}

export function livePreviewHeightUpperBound(
  terminalRows: number,
  providerCount: number,
  horizontal: boolean
): number {
  const count = Math.max(1, providerCount);
  const preview = livePreviewRows(terminalRows, count, horizontal);
  if (preview === 0) return 4;
  return horizontal ? preview + 8 : count * (preview + 5) + 3;
}

export function cloneLiveSnapshot(snapshot: LiveSnapshot): LiveSnapshot {
  return {
    ...snapshot,
    providers: [...snapshot.providers],
    panels: Object.fromEntries(
      Object.entries(snapshot.panels).map(([provider, panel]) => [provider, { ...panel }])
    ) as Record<ProviderId, LivePanelState>
  };
}

function statusColor(status: ProviderStatus): "green" | "red" | "yellow" | "cyan" {
  if (status === "completed") return "green";
  if (status === "failed" || status === "blocked_by_approval") return "red";
  if (status === "cancelled" || status === "skipped") return "yellow";
  return "cyan";
}

export function CouncilSnapshotView({
  snapshot,
  terminalColumns,
  previewRows
}: {
  snapshot: LiveSnapshot;
  terminalColumns: number;
  previewRows?: number;
}) {
  const horizontal = terminalColumns >= HORIZONTAL_MINIMUM_COLUMNS;
  const contentWidth = panelContentWidth(terminalColumns, snapshot.providers.length, horizontal);
  const completeRows = Object.fromEntries(
    snapshot.providers.map((provider) => [
      provider,
      outputDisplayRows(snapshot.panels[provider].text, contentWidth)
    ])
  ) as Partial<Record<ProviderId, string[]>>;
  const shownRows = Object.fromEntries(
    snapshot.providers.map((provider) => {
      const rows = completeRows[provider] ?? [WAITING_TEXT];
      return [
        provider,
        previewRows === undefined ? rows : previewRows === 0 ? [] : rows.slice(-previewRows)
      ];
    })
  ) as Partial<Record<ProviderId, string[]>>;
  const commonOutputHeight = commonPanelOutputHeight(
    snapshot.providers.map((provider) => shownRows[provider] ?? []),
    horizontal
  );

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>
          Stage {STAGE_NUMBER[snapshot.stage]} of 3: {STAGE_NAMES[snapshot.stage]}
        </Text>
        <Text>{elapsed(snapshot.startedAt)}</Text>
      </Box>
      <Text dimColor>
        Session {snapshot.sessionLabel} · Run {snapshot.runId}
      </Text>
      {previewRows === 0 ? (
        <Text>
          {snapshot.providers
            .map((provider) => `${DISPLAY_NAMES[provider]}: ${snapshot.panels[provider].status}`)
            .join(" · ")}
        </Text>
      ) : (
        <Box flexDirection={horizontal ? "row" : "column"} marginTop={1}>
          {snapshot.providers.map((provider, index) => {
            const panel = snapshot.panels[provider];
            const rows = shownRows[provider] ?? [];
            const last = index === snapshot.providers.length - 1;
            return (
              <Box
                key={provider}
                borderStyle="round"
                flexDirection="column"
                flexGrow={1}
                flexBasis={0}
                marginRight={horizontal && !last ? 1 : 0}
                marginBottom={!horizontal && !last ? 1 : 0}
                paddingX={1}
              >
                <Text bold>{DISPLAY_NAMES[provider]}</Text>
                <Text color={statusColor(panel.status)}>{panel.status}</Text>
                <Box height={commonOutputHeight} flexDirection="column">
                  <Text>{rows.join("\n")}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
      <Text dimColor>
        {previewRows === undefined
          ? "Complete stage output · Also saved under .council/."
          : "Live tail preview · Complete stage output will be appended to terminal history · Ctrl+C cancel."}
      </Text>
    </Box>
  );
}

export function CouncilLiveApp({
  initial,
  subscribe
}: {
  initial: LiveSnapshot;
  subscribe: (listener: (snapshot: LiveSnapshot) => void) => () => void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [, setTick] = useState(0);
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState({
    columns: stdout.columns || 80,
    rows: stdout.rows || DEFAULT_TERMINAL_ROWS
  });
  const horizontal = terminalSize.columns >= HORIZONTAL_MINIMUM_COLUMNS;
  const previewRows = livePreviewRows(terminalSize.rows, snapshot.providers.length, horizontal);

  useEffect(() => subscribe(setSnapshot), [subscribe]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const handleResize = () =>
      setTerminalSize({
        columns: stdout.columns || 80,
        rows: stdout.rows || DEFAULT_TERMINAL_ROWS
      });
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  return (
    <CouncilSnapshotView
      snapshot={snapshot}
      terminalColumns={terminalSize.columns}
      previewRows={previewRows}
    />
  );
}

export function renderCompleteSnapshot(snapshot: LiveSnapshot, terminalColumns: number): string {
  return renderToString(
    <CouncilSnapshotView snapshot={snapshot} terminalColumns={terminalColumns} />,
    { columns: terminalColumns }
  );
}

export function writeCompleteSnapshot(
  output: Pick<NodeJS.WriteStream, "write">,
  snapshot: LiveSnapshot,
  terminalColumns: number
): void {
  output.write(`${renderCompleteSnapshot(snapshot, terminalColumns)}\n`);
}

export function createLiveView(
  initial: LiveSnapshot,
  streams: LiveViewStreams = { stdout: process.stdout }
): LiveView {
  if (!streams.stdout.isTTY) return { update: () => undefined, close: () => Promise.resolve() };
  const listeners = new Set<(snapshot: LiveSnapshot) => void>();
  const subscribe = (listener: (snapshot: LiveSnapshot) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let latest = cloneLiveSnapshot(initial);
  let instance: Instance | null = render(
    <CouncilLiveApp initial={latest} subscribe={subscribe} />,
    {
      stdout: streams.stdout,
      ...LIVE_RENDER_OPTIONS
    }
  );
  return {
    update(snapshot) {
      latest = cloneLiveSnapshot(snapshot);
      for (const listener of listeners) listener(latest);
    },
    async close(options) {
      if (instance === null) return;
      const closingInstance = instance;
      // Replace the app before clearing so Ink cannot flush a throttled, stale
      // live frame during unmount. Unmount alone keeps its last frame in history.
      closingInstance.rerender(<></>);
      closingInstance.clear();
      closingInstance.unmount();
      instance = null;
      await closingInstance.waitUntilExit();
      if (options?.preserveCompleteOutput === false) return;
      await new Promise<void>((resolve, reject) => {
        streams.stdout.write(
          `${renderCompleteSnapshot(latest, streams.stdout.columns || 80)}\n`,
          (error) => {
            if (error) reject(error);
            else resolve();
          }
        );
      });
    }
  };
}
