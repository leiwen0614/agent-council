import { describe, expect, it } from "vitest";
import { parseCouncilProviders, parseProviders } from "../../src/cli/interaction.js";

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
