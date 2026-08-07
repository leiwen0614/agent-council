import { describe, expect, it } from "vitest";
import type { LiveSnapshot } from "../../src/ui/live.js";
import {
  applyPanelScroll,
  cloneLiveSnapshot,
  derivePanelViewport,
  focusIndexForNumber,
  formatViewportStatus,
  moveFocusIndex,
  outputDisplayRows,
  panelContentWidth,
  updatePanelScrollStates,
  visibleProviders
} from "../../src/ui/live.js";

describe("live snapshot updates", () => {
  it("copies mutable panel state so React receives a new snapshot", () => {
    const source: LiveSnapshot = {
      providers: ["claude", "copilot"],
      sessionLabel: "test",
      runId: "run",
      stage: "initial",
      startedAt: 0,
      panels: {
        codex: { status: "skipped", text: "" },
        claude: { status: "waiting", text: "" },
        copilot: { status: "waiting", text: "" }
      }
    };

    const clone = cloneLiveSnapshot(source);
    source.panels.claude.status = "running";

    expect(clone).not.toBe(source);
    expect(clone.panels).not.toBe(source.panels);
    expect(clone.panels.claude.status).toBe("waiting");
  });
});

describe("live panel viewport", () => {
  const rows = Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`);

  it("initially follows the latest output rows", () => {
    const viewport = derivePanelViewport(rows, 4, { startLine: 0, following: true });

    expect(viewport.rows).toEqual(["line 7", "line 8", "line 9", "line 10"]);
    expect(viewport.startLine).toBe(6);
    expect(formatViewportStatus(viewport)).toBe("lines 7–10/10 · LIVE");
  });

  it("scrolls by a line and a page", () => {
    const oneLine = applyPanelScroll({ startLine: 0, following: true }, "line-up", rows.length, 4);
    const onePage = applyPanelScroll(oneLine, "page-up", rows.length, 4);

    expect(oneLine).toEqual({ startLine: 5, following: false });
    expect(onePage).toEqual({ startLine: 1, following: false });
  });

  it("clamps at both bounds and supports Home and End", () => {
    const home = applyPanelScroll({ startLine: 0, following: true }, "home", rows.length, 4);
    const pastTop = applyPanelScroll(home, "page-up", rows.length, 4);
    const end = applyPanelScroll(pastTop, "end", rows.length, 4);

    expect(pastTop).toEqual({ startLine: 0, following: false });
    expect(end).toEqual({ startLine: 6, following: true });
  });

  it("scrolls down while paused without implicitly resuming live following", () => {
    const oneLine = applyPanelScroll(
      { startLine: 2, following: false },
      "line-down",
      rows.length,
      4
    );
    const atBottom = applyPanelScroll(oneLine, "page-down", rows.length, 4);
    const pastBottom = applyPanelScroll(atBottom, "line-down", rows.length, 4);

    expect(oneLine).toEqual({ startLine: 3, following: false });
    expect(atBottom).toEqual({ startLine: 6, following: false });
    expect(pastBottom).toEqual({ startLine: 6, following: false });
  });

  it("keeps a scrolled viewport stable when output is appended", () => {
    const state = { startLine: 2, following: false };

    expect(derivePanelViewport(rows, 4, state).rows).toEqual([
      "line 3",
      "line 4",
      "line 5",
      "line 6"
    ]);
    expect(derivePanelViewport([...rows, "line 11"], 4, state).rows).toEqual([
      "line 3",
      "line 4",
      "line 5",
      "line 6"
    ]);
  });

  it("maintains independent scroll state for each provider", () => {
    const claudeScrolled = updatePanelScrollStates({}, "claude", "page-up", rows.length, 4);
    const copilotScrolled = updatePanelScrollStates(
      claudeScrolled,
      "copilot",
      "line-up",
      rows.length,
      4
    );

    expect(copilotScrolled.claude).toEqual({ startLine: 2, following: false });
    expect(copilotScrolled.copilot).toEqual({ startLine: 5, following: false });
    expect(copilotScrolled.codex).toBeUndefined();
  });

  it("advances a following viewport when output is appended", () => {
    const state = { startLine: 0, following: true };

    expect(derivePanelViewport(rows, 4, state).rows.at(-1)).toBe("line 10");
    expect(derivePanelViewport([...rows, "line 11"], 4, state).rows.at(-1)).toBe("line 11");
  });

  it("hard-wraps long logical lines without dropping empty lines", () => {
    expect(outputDisplayRows("abcdefghij\n\nxy", 4)).toEqual(["abcd", "efgh", "ij", "", "xy"]);
  });

  it("reflows display rows when panel width changes", () => {
    expect(outputDisplayRows("abcdefghijkl", 6)).toEqual(["abcdef", "ghijkl"]);
    expect(outputDisplayRows("abcdefghijkl", 4)).toEqual(["abcd", "efgh", "ijkl"]);
  });

  it("clamps a paused viewport after wrapping produces fewer rows", () => {
    const state = { startLine: 4, following: false };
    const narrowRows = outputDisplayRows("abcdefghijklmnopqrstuvwx", 4);
    const wideRows = outputDisplayRows("abcdefghijklmnopqrstuvwx", 8);

    expect(derivePanelViewport(narrowRows, 2, state).startLine).toBe(4);
    expect(derivePanelViewport(wideRows, 2, state).startLine).toBe(1);
    expect(derivePanelViewport(wideRows, 2, state).rows).toEqual(["ijklmnop", "qrstuvwx"]);
  });

  it("normalizes CRLF while preserving internal blank rows", () => {
    expect(outputDisplayRows("first\r\n\r\nsecond", 20)).toEqual(["first", "", "second"]);
  });

  it("wraps full-width Unicode by terminal column width", () => {
    expect(outputDisplayRows("你好世界", 4)).toEqual(["你好", "世界"]);
  });

  it("wraps ANSI-styled content by visible width", () => {
    const rowsWithAnsi = outputDisplayRows("\u001B[31mabcdef\u001B[39m", 3);

    expect(rowsWithAnsi).toHaveLength(2);
    expect(rowsWithAnsi[0]).toContain("abc");
    expect(rowsWithAnsi[1]).toContain("def");
  });

  it("uses a waiting row for empty output", () => {
    expect(outputDisplayRows(" \r\n", 10)).toEqual(["Waiting for output…"]);
  });

  it("formats an empty viewport without inventing a line range", () => {
    expect(
      formatViewportStatus(derivePanelViewport([], 4, { startLine: 0, following: true }))
    ).toBe("lines 0–0/0 · LIVE");
  });

  it("calculates content width for horizontal and stacked panels", () => {
    expect(panelContentWidth(120, 3, true)).toBe(35);
    expect(panelContentWidth(80, 3, false)).toBe(76);
  });
});

describe("live panel focus and expansion", () => {
  const providers = ["codex", "claude", "copilot"] as const;

  it("cycles focus in both directions", () => {
    expect(moveFocusIndex(0, providers.length, "previous")).toBe(2);
    expect(moveFocusIndex(2, providers.length, "next")).toBe(0);
    expect(moveFocusIndex(0, 2, "next")).toBe(1);
    expect(moveFocusIndex(1, 2, "next")).toBe(0);
    expect(moveFocusIndex(0, 2, "previous")).toBe(1);
  });

  it("maps only available number keys to a provider", () => {
    expect(focusIndexForNumber("1", 2)).toBe(0);
    expect(focusIndexForNumber("2", 2)).toBe(1);
    expect(focusIndexForNumber("3", 2)).toBeNull();
    expect(focusIndexForNumber("x", 3)).toBeNull();
  });

  it("shows every provider normally and only the focused provider when expanded", () => {
    expect(visibleProviders(providers, 1, false)).toEqual(providers);
    expect(visibleProviders(providers, 1, true)).toEqual(["claude"]);
    expect(visibleProviders(["claude", "copilot"], 20, true)).toEqual(["copilot"]);
  });
});
