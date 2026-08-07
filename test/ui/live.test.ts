import { describe, expect, it } from "vitest";
import type { LiveSnapshot } from "../../src/ui/live.js";
import { cloneLiveSnapshot } from "../../src/ui/live.js";

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
