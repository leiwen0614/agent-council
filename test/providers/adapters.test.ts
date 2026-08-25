import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa, type ResultPromise } from "execa";
import { ClaudeAdapter, CodexAdapter, CopilotAdapter } from "../../src/providers/index.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

const mockedExeca = vi.mocked(execa);

afterEach(() => {
  vi.clearAllMocks();
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

function fakeCommandResult(exitCode: number, stdout: string, stderr = ""): ResultPromise {
  return Promise.resolve({ exitCode, stdout, stderr }) as unknown as ResultPromise;
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

    mockedExeca.mockReturnValueOnce(fakeProcess());
    new ClaudeAdapter().start({ prompt: "task", cwd: "C:/repo", yolo: false, ...defaults });
    expect(latestArguments()).toEqual(
      expect.arrayContaining(["--permission-mode", "dontAsk", "--tools", ""])
    );
    expect(latestArguments()).not.toContain("--safe-mode");
  });

  it("allows an explicitly isolated Codex start outside a Git repository", () => {
    mockedExeca.mockReturnValueOnce(fakeProcess());
    new CodexAdapter().start({
      prompt: "blind evaluation",
      cwd: "C:/isolated",
      allowNonGitWorkingDirectory: true,
      yolo: false,
      ...defaults
    });
    expect(latestArguments()).toContain("--skip-git-repo-check");
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
      effort: "xhigh",
      sessionId: "claude-session"
    });
    expect(latestArguments()).toEqual(
      expect.arrayContaining(["--model", "claude-opus-4-8", "--effort", "xhigh"])
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
  it("accepts a Claude custom provider configured in Claude settings without exposing credentials", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "agent-council-claude-"));
    const providerToken = "secret-provider-token";
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
    await writeFile(
      join(configDirectory, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:23333/api/anthropic",
          ANTHROPIC_AUTH_TOKEN: providerToken
        }
      }),
      "utf8"
    );

    try {
      const result = await new ClaudeAdapter().checkAuthenticated();

      expect(result).toEqual({
        ok: true,
        summary: "Claude is available through the configured API provider.",
        detail: "A custom Anthropic API endpoint and provider authentication are configured."
      });
      expect(mockedExeca).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(providerToken);
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  });

  it("uses Claude first-party authentication when no custom provider is configured", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "Z:/path-that-does-not-exist");
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mockedExeca.mockReturnValueOnce(
      fakeCommandResult(
        0,
        JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" })
      )
    );

    const result = await new ClaudeAdapter().checkAuthenticated();

    expect(result).toEqual({ ok: true, summary: "Claude is authenticated." });
    expect(mockedExeca).toHaveBeenCalledWith(
      "claude",
      ["auth", "status", "--json"],
      expect.objectContaining({ reject: false, shell: false })
    );
  });

  it("accepts a Codex custom provider that does not require OpenAI login", async () => {
    mockedExeca.mockReturnValueOnce(
      fakeCommandResult(
        1,
        JSON.stringify({
          overallStatus: "fail",
          checks: {
            "auth.credentials": {
              status: "ok",
              summary: "OpenAI auth is not required for the active model provider",
              remediation: null
            },
            "network.provider_reachability": { status: "fail" }
          }
        })
      )
    );

    const result = await new CodexAdapter().checkAuthenticated();

    expect(result).toEqual({
      ok: true,
      summary:
        "Codex is available through the active model provider; OpenAI login is not required.",
      detail: "OpenAI auth is not required for the active model provider"
    });
    expect(mockedExeca).toHaveBeenCalledOnce();
    expect(mockedExeca).toHaveBeenCalledWith(
      "codex",
      ["doctor", "--json"],
      expect.objectContaining({ reject: false, shell: false })
    );
  });

  it("uses Codex login status when the installed CLI has no machine-readable doctor report", async () => {
    mockedExeca
      .mockReturnValueOnce(fakeCommandResult(2, "", "unknown command: doctor"))
      .mockReturnValueOnce(fakeCommandResult(0, "Logged in using ChatGPT"));

    const result = await new CodexAdapter().checkAuthenticated();

    expect(result).toEqual({
      ok: true,
      summary: "Codex is authenticated.",
      detail: "Logged in using ChatGPT"
    });
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    expect(mockedExeca.mock.calls[1]?.[1]).toEqual(["login", "status"]);
  });

  it("reports an active Codex provider whose required authentication is missing", async () => {
    mockedExeca.mockReturnValueOnce(
      fakeCommandResult(
        1,
        JSON.stringify({
          checks: {
            "auth.credentials": {
              status: "fail",
              summary: "Required provider credential is missing",
              remediation: "Set the provider credential."
            }
          }
        })
      )
    );

    const result = await new CodexAdapter().checkAuthenticated();

    expect(result).toEqual({
      ok: false,
      summary: "Codex authentication is not available for the active model provider.",
      detail: "Required provider credential is missing",
      remediation: "Set the provider credential."
    });
  });

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
