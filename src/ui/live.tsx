import React, { useEffect, useState } from "react";
import { Box, Text, render, useInput, useStdin, useStdout, type Instance } from "ink";
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

export type LiveView = { update(snapshot: LiveSnapshot): void; close(): void };

export type PanelScrollState = {
  /** Zero-based display row at the top when live following is disabled. */
  startLine: number;
  following: boolean;
};

export type PanelScrollAction = "line-up" | "line-down" | "page-up" | "page-down" | "home" | "end";

export type PanelViewport = {
  rows: string[];
  /** Zero-based, inclusive display-row offset. */
  startLine: number;
  /** Zero-based, exclusive display-row offset. */
  endLine: number;
  totalLines: number;
  following: boolean;
};

export type FocusDirection = "previous" | "next";

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
const INITIAL_SCROLL_STATE: PanelScrollState = { startLine: 0, following: true };

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const values = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return values.map((value) => String(value).padStart(2, "0")).join(":");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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

export function derivePanelViewport(
  rows: readonly string[],
  viewportHeight: number,
  state: PanelScrollState
): PanelViewport {
  const height = Math.max(1, viewportHeight);
  const maximumStart = Math.max(0, rows.length - height);
  const startLine = state.following ? maximumStart : clamp(state.startLine, 0, maximumStart);
  const visibleRows = rows.slice(startLine, startLine + height);
  return {
    rows: visibleRows,
    startLine,
    endLine: startLine + visibleRows.length,
    totalLines: rows.length,
    following: state.following
  };
}

export function applyPanelScroll(
  state: PanelScrollState,
  action: PanelScrollAction,
  totalLines: number,
  viewportHeight: number
): PanelScrollState {
  const height = Math.max(1, viewportHeight);
  const maximumStart = Math.max(0, totalLines - height);
  const currentStart = state.following ? maximumStart : clamp(state.startLine, 0, maximumStart);

  if (action === "end") return { startLine: maximumStart, following: true };
  if (action === "home") return { startLine: 0, following: false };
  if (state.following && (action === "line-down" || action === "page-down")) {
    return { startLine: maximumStart, following: true };
  }

  const delta =
    action === "line-up"
      ? -1
      : action === "line-down"
        ? 1
        : action === "page-up"
          ? -height
          : height;
  return {
    startLine: clamp(currentStart + delta, 0, maximumStart),
    following: false
  };
}

export function updatePanelScrollStates(
  states: Partial<Record<ProviderId, PanelScrollState>>,
  provider: ProviderId,
  action: PanelScrollAction,
  totalLines: number,
  viewportHeight: number
): Partial<Record<ProviderId, PanelScrollState>> {
  return {
    ...states,
    [provider]: applyPanelScroll(
      states[provider] ?? INITIAL_SCROLL_STATE,
      action,
      totalLines,
      viewportHeight
    )
  };
}

export function moveFocusIndex(
  currentIndex: number,
  providerCount: number,
  direction: FocusDirection
): number {
  if (providerCount <= 0) return 0;
  const normalized = ((currentIndex % providerCount) + providerCount) % providerCount;
  const delta = direction === "previous" ? -1 : 1;
  return (normalized + delta + providerCount) % providerCount;
}

export function focusIndexForNumber(input: string, providerCount: number): number | null {
  if (!/^[1-3]$/.test(input)) return null;
  const index = Number(input) - 1;
  return index < providerCount ? index : null;
}

export function visibleProviders(
  providers: readonly ProviderId[],
  focusedIndex: number,
  expanded: boolean
): ProviderId[] {
  if (!expanded) return [...providers];
  const provider = providers[clamp(focusedIndex, 0, Math.max(0, providers.length - 1))];
  return provider === undefined ? [] : [provider];
}

export function formatViewportStatus(viewport: PanelViewport): string {
  const range =
    viewport.totalLines === 0
      ? "lines 0–0/0"
      : `lines ${String(viewport.startLine + 1)}–${String(viewport.endLine)}/${String(
          viewport.totalLines
        )}`;
  return `${range} · ${viewport.following ? "LIVE" : "PAUSED"}`;
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

function CouncilLiveApp({
  initial,
  maxPanelLines,
  onInterrupt,
  subscribe
}: {
  initial: LiveSnapshot;
  maxPanelLines: number;
  onInterrupt: () => void;
  subscribe: (listener: (snapshot: LiveSnapshot) => void) => () => void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [scrollStates, setScrollStates] = useState<Partial<Record<ProviderId, PanelScrollState>>>(
    {}
  );
  const [, setTick] = useState(0);
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const [terminalColumns, setTerminalColumns] = useState(stdout.columns || 80);
  const safeFocusedIndex = clamp(focusedIndex, 0, Math.max(0, snapshot.providers.length - 1));
  const shownProviders = visibleProviders(snapshot.providers, safeFocusedIndex, expanded);
  const horizontal = terminalColumns >= HORIZONTAL_MINIMUM_COLUMNS;
  const contentWidth = panelContentWidth(terminalColumns, shownProviders.length, horizontal);

  useEffect(() => subscribe(setSnapshot), [subscribe]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const handleResize = () => setTerminalColumns(stdout.columns || 80);
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);
  useEffect(() => {
    setFocusedIndex((current) => clamp(current, 0, Math.max(0, snapshot.providers.length - 1)));
  }, [snapshot.providers.length]);

  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === "c") {
        onInterrupt();
        return;
      }
      if (key.ctrl) return;

      const providerCount = snapshot.providers.length;
      if (providerCount === 0) return;
      if (key.escape) {
        setExpanded(false);
        return;
      }
      if (key.return || input.toLowerCase() === "f") {
        setExpanded((current) => !current);
        return;
      }

      const directIndex = focusIndexForNumber(input, providerCount);
      if (directIndex !== null) {
        setFocusedIndex(directIndex);
        return;
      }

      if (key.leftArrow || (key.tab && key.shift)) {
        setFocusedIndex((current) => moveFocusIndex(current, providerCount, "previous"));
        return;
      }
      if (key.rightArrow || key.tab) {
        setFocusedIndex((current) => moveFocusIndex(current, providerCount, "next"));
        return;
      }

      const action: PanelScrollAction | null =
        key.upArrow || input === "k"
          ? "line-up"
          : key.downArrow || input === "j"
            ? "line-down"
            : key.pageUp
              ? "page-up"
              : key.pageDown
                ? "page-down"
                : key.home
                  ? "home"
                  : key.end
                    ? "end"
                    : null;
      if (action === null) return;

      const provider = snapshot.providers[safeFocusedIndex];
      if (provider === undefined) return;
      const totalLines = outputDisplayRows(snapshot.panels[provider].text, contentWidth).length;
      setScrollStates((current) =>
        updatePanelScrollStates(current, provider, action, totalLines, maxPanelLines)
      );
    },
    { isActive: isRawModeSupported }
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
      <Box flexDirection={horizontal ? "row" : "column"} marginTop={1}>
        {shownProviders.map((provider, shownIndex) => {
          const panel = snapshot.panels[provider];
          const viewport = derivePanelViewport(
            outputDisplayRows(panel.text, contentWidth),
            maxPanelLines,
            scrollStates[provider] ?? INITIAL_SCROLL_STATE
          );
          const providerIndex = snapshot.providers.indexOf(provider);
          const focused = providerIndex === safeFocusedIndex;
          const last = shownIndex === shownProviders.length - 1;
          return (
            <Box
              key={provider}
              borderStyle="round"
              borderColor={focused ? "cyan" : undefined}
              flexDirection="column"
              flexGrow={1}
              flexBasis={0}
              marginRight={horizontal && !last ? 1 : 0}
              marginBottom={!horizontal && !last ? 1 : 0}
              paddingX={1}
            >
              <Text bold>
                {providerIndex + 1} · {DISPLAY_NAMES[provider]}
                {expanded ? " · full width" : ""}
              </Text>
              <Text color={statusColor(panel.status)}>{panel.status}</Text>
              <Box height={maxPanelLines} overflowY="hidden" flexDirection="column">
                <Text>{viewport.rows.join("\n")}</Text>
              </Box>
              <Text dimColor>{formatViewportStatus(viewport)}</Text>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>
        Tab/Shift+Tab/←/→ or 1–3 select · ↑/↓ scroll · PgUp/PgDn page · Home start · End live
      </Text>
      <Text dimColor>
        Enter/f full width · Esc all panels · Ctrl+C cancel · Full output is streaming and saved.
      </Text>
    </Box>
  );
}

export function createLiveView(
  initial: LiveSnapshot,
  maxPanelLines: number,
  onInterrupt: () => void
): LiveView {
  if (!process.stdout.isTTY) return { update: () => undefined, close: () => undefined };
  const listeners = new Set<(snapshot: LiveSnapshot) => void>();
  const subscribe = (listener: (snapshot: LiveSnapshot) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let instance: Instance | null = render(
    <CouncilLiveApp
      initial={initial}
      maxPanelLines={maxPanelLines}
      onInterrupt={onInterrupt}
      subscribe={subscribe}
    />,
    { exitOnCtrlC: false }
  );
  return {
    update(snapshot) {
      const next = cloneLiveSnapshot(snapshot);
      for (const listener of listeners) listener(next);
    },
    close() {
      instance?.unmount();
      instance = null;
    }
  };
}
