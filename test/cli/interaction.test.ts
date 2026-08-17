import { describe, expect, it, vi } from "vitest";
import {
  parseCouncilProviders,
  parseProviders,
  restoreInteractiveInput
} from "../../src/cli/interaction.js";

describe("interactive input lifecycle", () => {
  it("re-references TTY input after the live view releases it", () => {
    const ref = vi.fn();

    restoreInteractiveInput({ isTTY: true, ref });

    expect(ref).toHaveBeenCalledOnce();
  });

  it("does not keep non-interactive input alive", () => {
    const ref = vi.fn();

    restoreInteractiveInput({ isTTY: false, ref });

    expect(ref).not.toHaveBeenCalled();
  });
});

describe("provider list parsing", () => {
  it("accepts unique two-or-three-provider Councils", () => {
    expect(parseCouncilProviders("codex,copilot")).toEqual(["codex", "copilot"]);
    expect(parseCouncilProviders("codex,claude,copilot")).toHaveLength(3);
  });

  it("refuses a single-provider Council", () => {
    expect(() => parseCouncilProviders("codex")).toThrow("at least two");
  });

  it("rejects unknown names and deduplicates ordinary provider lists", () => {
    expect(parseProviders("codex,codex,copilot")).toEqual(["codex", "copilot"]);
    expect(() => parseProviders("codex,other")).toThrow("Unknown provider");
  });
});
