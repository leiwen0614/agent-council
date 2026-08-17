import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { PassThrough } from "node:stream";
import type { LiveSnapshot } from "../../src/ui/live.js";
import {
  CouncilSnapshotView,
  cloneLiveSnapshot,
  commonPanelOutputHeight,
  createLiveView,
  livePreviewHeightUpperBound,
  livePreviewRows,
  outputDisplayRows,
  panelContentWidth,
  writeCompleteSnapshot
} from "../../src/ui/live.js";

function renderLive(snapshot: LiveSnapshot, columns: number): string {
  return renderToString(
    React.createElement(CouncilSnapshotView, {
      snapshot,
      terminalColumns: columns
    }),
    { columns }
  );
}

function panelSnapshot(claudeText: string, copilotText: string): LiveSnapshot {
  return {
    providers: ["claude", "copilot"],
    sessionLabel: "test",
    runId: "run",
    stage: "initial",
    startedAt: 0,
    panels: {
      codex: { status: "skipped", text: "" },
      claude: { status: "completed", text: claudeText },
      copilot: { status: "running", text: copilotText }
    }
  };
}

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

describe("live panel output", () => {
  it("retains every wrapped output row without truncation", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`).join("\n");

    expect(outputDisplayRows(text, 20)).toEqual(
      Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`)
    );
  });

  it("hard-wraps long logical lines without dropping empty lines", () => {
    expect(outputDisplayRows("abcdefghij\n\nxy", 4)).toEqual(["abcd", "efgh", "ij", "", "xy"]);
  });

  it("reflows complete display rows when panel width changes", () => {
    expect(outputDisplayRows("abcdefghijkl", 6)).toEqual(["abcdef", "ghijkl"]);
    expect(outputDisplayRows("abcdefghijkl", 4)).toEqual(["abcd", "efgh", "ijkl"]);
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

  it("uses the longest complete output height for horizontal panels", () => {
    const rows = [["one", "two"], ["one", "two", "three", "four"], ["one"]];

    expect(commonPanelOutputHeight(rows, true)).toBe(4);
  });

  it("does not impose a common output height on stacked panels", () => {
    expect(commonPanelOutputHeight([["one"], ["one", "two", "three"]], false)).toBeUndefined();
  });

  it("handles an empty horizontal provider set safely", () => {
    expect(commonPanelOutputHeight([], true)).toBe(0);
  });

  it("calculates content width for horizontal and stacked panels", () => {
    expect(panelContentWidth(120, 3, true)).toBe(35);
    expect(panelContentWidth(80, 3, false)).toBe(76);
  });

  it("bounds the live preview below the physical terminal height", () => {
    expect(livePreviewRows(30, 2, true)).toBe(20);
    expect(livePreviewRows(20, 2, false)).toBe(2);
    expect(livePreviewRows(10, 3, false)).toBe(0);
    expect(livePreviewHeightUpperBound(30, 2, true)).toBeLessThan(30);
    expect(livePreviewHeightUpperBound(20, 2, false)).toBeLessThan(20);
    expect(livePreviewHeightUpperBound(10, 3, false)).toBeLessThan(10);
  });

  it("renders every horizontal row and aligns shorter panel borders", () => {
    const snapshot = panelSnapshot("short", "long 1\nlong 2\nlong 3");
    const output = renderLive(snapshot, 120);
    const lines = output.split("\n");

    expect(output).toContain("short");
    expect(output).toContain("long 1");
    expect(output).toContain("long 2");
    expect(output).toContain("long 3");
    const panelBottomRows = lines.filter((line) => line.startsWith("╰"));
    expect(panelBottomRows).toHaveLength(1);
    expect(panelBottomRows[0]?.match(/╰/g)).toHaveLength(2);
  });

  it("renders stacked panels at their natural complete heights", () => {
    const snapshot = panelSnapshot("short", "long 1\nlong 2\nlong 3");
    const output = renderLive(snapshot, 80);

    expect(output).toContain("short");
    expect(output).toContain("long 1");
    expect(output).toContain("long 2");
    expect(output).toContain("long 3");
    expect(output.split("\n").filter((line) => line.startsWith("╰"))).toHaveLength(2);
  });

  it("shows the waiting message in an empty provider panel", () => {
    expect(renderLive(panelSnapshot("", "working"), 120)).toContain("Waiting for output…");
  });

  it("writes a complete immutable stage snapshot without terminal-clear escapes", () => {
    let written = "";
    const snapshot = panelSnapshot("short", "long 1\nlong 2\nlong 3");

    writeCompleteSnapshot(
      {
        write(chunk: string | Uint8Array) {
          written += String(chunk);
          return true;
        }
      },
      snapshot,
      120
    );

    expect(written).toContain("short");
    expect(written).toContain("long 3");
    expect(written).not.toContain("\u001B[2J");
    expect(written).not.toContain("\u001B[3J");
  });

  it("keeps the complete stage in history without Ink's erase-scrollback sequence", async () => {
    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
      rows: number;
    };
    output.isTTY = true;
    output.columns = 120;
    output.rows = 30;
    let written = "";
    output.on("data", (chunk) => {
      written += String(chunk);
    });
    const finalText = Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`).join(
      "\n"
    );
    const initial = panelSnapshot("", "");
    const completed = panelSnapshot("short", finalText);
    completed.panels.copilot.status = "completed";

    const view = createLiveView(initial, { stdout: output as unknown as NodeJS.WriteStream });
    view.update(completed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await view.close();
    await new Promise<void>((resolve) => output.write("", () => resolve()));

    expect(written).toContain("line 60");
    expect(written).not.toContain("\u001B[3J");
  });

  it("clears the transient live frame when a stage attempt enters recovery", async () => {
    const output = new PassThrough() as PassThrough & {
      isTTY: boolean;
      columns: number;
      rows: number;
    };
    output.isTTY = true;
    output.columns = 120;
    output.rows = 30;
    let written = "";
    output.on("data", (chunk) => {
      written += String(chunk);
    });

    const view = createLiveView(panelSnapshot("", ""), {
      stdout: output as unknown as NodeJS.WriteStream
    });
    view.update(panelSnapshot("partial Claude", "partial Copilot"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await view.close({ preserveCompleteOutput: false });

    expect(written).toContain("\u001B[2K");
    expect(written.slice(written.indexOf("\u001B[2K"))).not.toContain("partial Copilot");
    expect(written).not.toContain("Complete stage output · Also saved under .council/.");
  });
});
