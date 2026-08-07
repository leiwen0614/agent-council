import React, { useEffect, useState } from "react";
import { Box, Text, render, type Instance } from "ink";
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

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const values = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return values.map((value) => String(value).padStart(2, "0")).join(":");
}

function tailLines(text: string, maximum: number): string {
  const normalized = text.trimEnd();
  return normalized.length === 0
    ? "Waiting for output…"
    : normalized.split(/\r?\n/).slice(-maximum).join("\n");
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
  subscribe
}: {
  initial: LiveSnapshot;
  maxPanelLines: number;
  subscribe: (listener: (snapshot: LiveSnapshot) => void) => () => void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [, setTick] = useState(0);

  useEffect(() => subscribe(setSnapshot), [subscribe]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

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
      <Box flexDirection={process.stdout.columns >= 100 ? "row" : "column"} marginTop={1}>
        {snapshot.providers.map((provider) => {
          const panel = snapshot.panels[provider];
          return (
            <Box
              key={provider}
              borderStyle="round"
              flexDirection="column"
              flexGrow={1}
              flexBasis={0}
              marginRight={provider === snapshot.providers.at(-1) ? 0 : 1}
              paddingX={1}
            >
              <Text bold>{DISPLAY_NAMES[provider]}</Text>
              <Text color={statusColor(panel.status)}>{panel.status}</Text>
              <Text wrap="truncate-end">{tailLines(panel.text, maxPanelLines)}</Text>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>Output is streaming live and being saved. Press Ctrl+C to cancel.</Text>
    </Box>
  );
}

export function createLiveView(initial: LiveSnapshot, maxPanelLines: number): LiveView {
  if (!process.stdout.isTTY) return { update: () => undefined, close: () => undefined };
  const listeners = new Set<(snapshot: LiveSnapshot) => void>();
  const subscribe = (listener: (snapshot: LiveSnapshot) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let instance: Instance | null = render(
    <CouncilLiveApp initial={initial} maxPanelLines={maxPanelLines} subscribe={subscribe} />
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
