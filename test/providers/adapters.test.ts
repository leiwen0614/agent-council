import { afterEach, describe, expect, it, vi } from "vitest";
import { execa, type ResultPromise } from "execa";
import { ClaudeAdapter, CodexAdapter, CopilotAdapter } from "../../src/providers/index.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

const mockedExeca = vi.mocked(execa);

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeProcess(): ResultPromise {
  const process = Promise.resolve({
    exitCode: 0,
    signal: undefined,
    isCanceled: false,
    isTerminated: false,
    failed: false,
    shortMessage: undefined
  }) as unknown as { pid: number; stdout: null; stderr: null };
  process.pid = 42;
  process.stdout = null;
  process.stderr = null;
  return process as unknown as ResultPromise;
}

describe("provider command construction", () => {
  const defaults = { model: null, effort: null };

  function latestArguments(): readonly string[] | undefined {
    const value = mockedExeca.mock.calls.at(-1)?.[1];
    return Array.isArray(value) ? value : undefined;
  }

  it("uses read-only noninteractive settings for safe mode", () => {
    mockedExeca.mockReturnValueOnce(fakeProcess());
    new CodexAdapter().start({ prompt: "task", cwd: "C:/repo", yolo: false, ...defaults });
    expect(mockedExeca).toHaveBeenCalledWith(
      "codex",
      ["exec", "--sandbox", "read-only", "--color", "never", "--json", "-"],
      expect.objectContaining({ input: "task", shell: false })
    );
  });

  it("keeps each provider's YOLO flag inside its adapter", () => {
    mockedExeca.mockReturnValueOnce(fakeProcess());
    new ClaudeAdapter().start({ prompt: "task", cwd: "C:/repo", yolo: true, ...defaults });
    expect(latestArguments()).toContain("--dangerously-skip-permissions");

    mockedExeca.mockReturnValueOnce(fakeProcess());
    new CopilotAdapter().start({ prompt: "task", cwd: "C:/repo", yolo: true, ...defaults });
    expect(latestArguments()).toContain("--yolo");
  });

  it("uses Copilot's read-only view tool for persisted large prompts", () => {
    mockedExeca.mockReturnValueOnce(fakeProcess());
    new CopilotAdapter().start({
      prompt: "large prompt content",
      promptPath: "C:/repo/.council/prompts/final/copilot.md",
      cwd: "C:/repo",
      yolo: false,
      ...defaults
    });
    expect(latestArguments()).toEqual(
      expect.arrayContaining(["--available-tools=view", "--allow-tool=view"])
    );
    expect(latestArguments()).not.toContain("large prompt content");
  });

  it("uses explicit stored provider session IDs when resuming", () => {
    mockedExeca.mockReturnValueOnce(fakeProcess());
    new CodexAdapter().resume({
      prompt: "next",
      cwd: "C:/repo",
      yolo: false,
      ...defaults,
      sessionId: "saved-session"
    });
    expect(latestArguments()).toEqual([
      "exec",
      "resume",
      "--config",
      'sandbox_mode="read-only"',
      "--json",
      "saved-session",
      "-"
    ]);
  });

  it("passes provider-specific model and maximum effort settings on start and resume", () => {
    mockedExeca.mockReturnValueOnce(fakeProcess());
    new CodexAdapter().start({
      prompt: "task",
      cwd: "C:/repo",
      yolo: true,
      model: "gpt-5.6-sol",
      effort: "xhigh"
    });
    expect(latestArguments()).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-5.6-sol",
        "--config",
        'model_reasoning_effort="xhigh"'
      ])
    );

    mockedExeca.mockReturnValueOnce(fakeProcess());
    new ClaudeAdapter().resume({
      prompt: "task",
      cwd: "C:/repo",
      yolo: true,
      model: "claude-opus-4-8",
      effort: "max",
      sessionId: "claude-session"
    });
    expect(latestArguments()).toEqual(
      expect.arrayContaining(["--model", "claude-opus-4-8", "--effort", "max"])
    );

    mockedExeca.mockReturnValueOnce(fakeProcess());
    new CopilotAdapter().resume({
      prompt: "task",
      cwd: "C:/repo",
      yolo: true,
      model: "gpt-5.6-sol",
      effort: "max",
      sessionId: "copilot-session"
    });
    expect(latestArguments()).toEqual(
      expect.arrayContaining(["--model", "gpt-5.6-sol", "--effort", "max"])
    );
  });
});

describe("provider authentication diagnostics", () => {
  it("recognizes Copilot's official environment-token authentication without exposing it", async () => {
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "secret-test-token");
    vi.stubEnv("COPILOT_HOME", "Z:/path-that-does-not-exist");

    const result = await new CopilotAdapter().checkAuthenticated();

    expect(result).toEqual({
      ok: true,
      summary: "Copilot authentication is available from the environment."
    });
    expect(JSON.stringify(result)).not.toContain("secret-test-token");
  });
});
