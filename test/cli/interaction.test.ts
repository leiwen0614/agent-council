import { beforeEach, describe, expect, it, vi } from "vitest";

const promptMocks = vi.hoisted(() => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn()
}));

vi.mock("@inquirer/prompts", () => promptMocks);

import {
  askPrompt,
  parseCouncilProviders,
  parseProviders,
  restoreInteractiveInput
} from "../../src/cli/interaction.js";

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("Council prompt input", () => {
  it("collects the prompt in the terminal without launching an editor", async () => {
    promptMocks.input.mockResolvedValueOnce("Compare these approaches");

    await expect(askPrompt()).resolves.toBe("Compare these approaches");
    expect(promptMocks.input).toHaveBeenCalledOnce();
    expect(promptMocks.input).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter the Council prompt" })
    );
  });

  it("rejects an empty terminal prompt", () => {
    const options = {
      message: "",
      validate: (answer: string) => Boolean(answer) as boolean | string
    };
    promptMocks.input.mockImplementationOnce((value: typeof options) => {
      options.message = value.message;
      options.validate = value.validate;
      return Promise.resolve("answer");
    });

    return askPrompt().then(() => {
      expect(options.validate("   ")).toBe("The prompt cannot be empty.");
      expect(options.validate("question")).toBe(true);
    });
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
