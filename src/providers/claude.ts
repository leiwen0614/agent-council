import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { DiagnosticResult } from "../core/types.js";
import { redactSecrets } from "../util/redact.js";
import { BaseAdapter } from "./base.js";
import { parseClaudeLine } from "./parsers.js";
import { spawnAgentProcess } from "./process.js";
import type { AgentProcess, ResumeOptions, StartOptions } from "./types.js";

const authStatusSchema = z.object({ loggedIn: z.boolean() }).passthrough();
const settingsSchema = z
  .object({
    env: z.record(z.string()).optional()
  })
  .passthrough();

const CLAUDE_PROVIDER_VARIABLES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY"
] as const;
type ClaudeProviderVariable = (typeof CLAUDE_PROVIDER_VARIABLES)[number];
type ClaudeProviderEnvironment = Record<ClaudeProviderVariable, string | undefined>;

function hasValue(value: string | undefined): boolean {
  return (value ?? "").trim().length > 0;
}

function hasConfiguredApiProvider(environment: ClaudeProviderEnvironment): boolean {
  return (
    hasValue(environment.ANTHROPIC_BASE_URL) &&
    (hasValue(environment.ANTHROPIC_AUTH_TOKEN) || hasValue(environment.ANTHROPIC_API_KEY))
  );
}

async function loadConfiguredProviderEnvironment(
  environment: NodeJS.ProcessEnv
): Promise<ClaudeProviderEnvironment> {
  const values: ClaudeProviderEnvironment = {
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined
  };
  const configDirectory = environment["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const settingsPaths = new Set([
    join(configDirectory, "settings.json"),
    join(process.cwd(), ".claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.local.json")
  ]);

  for (const path of settingsPaths) {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (!parsed.success || parsed.data.env === undefined) continue;
      for (const name of CLAUDE_PROVIDER_VARIABLES) {
        if (Object.hasOwn(parsed.data.env, name)) values[name] = parsed.data.env[name];
      }
    } catch {
      // Claude owns settings validation. An unreadable source cannot establish provider readiness.
    }
  }

  // Process variables take precedence over settings-file environment entries in Claude Code.
  for (const name of CLAUDE_PROVIDER_VARIABLES) {
    if (environment[name] !== undefined) values[name] = environment[name];
  }
  return values;
}

export class ClaudeAdapter extends BaseAdapter {
  readonly id = "claude" as const;
  protected readonly executable = "claude";

  async checkAuthenticated(): Promise<DiagnosticResult> {
    const providerEnvironment = await loadConfiguredProviderEnvironment(process.env);
    if (hasConfiguredApiProvider(providerEnvironment)) {
      return {
        ok: true,
        summary: "Claude is available through the configured API provider.",
        detail: "A custom Anthropic API endpoint and provider authentication are configured."
      };
    }

    try {
      const result = await execa(this.executable, ["auth", "status", "--json"], {
        reject: false,
        shell: false,
        windowsHide: true
      });
      const parsed = authStatusSchema.safeParse(JSON.parse(result.stdout) as unknown);
      if (result.exitCode === 0 && parsed.success && parsed.data.loggedIn)
        return { ok: true, summary: "Claude is authenticated." };
      return {
        ok: false,
        summary: "Claude is not authenticated.",
        detail: redactSecrets(result.stderr),
        remediation: "Run: claude auth login"
      };
    } catch {
      return {
        ok: false,
        summary: "Claude authentication could not be checked.",
        remediation: "Run: claude auth login"
      };
    }
  }

  start(options: StartOptions): AgentProcess {
    return this.spawn(options, false);
  }
  resume(options: ResumeOptions): AgentProcess {
    return this.spawn(options, true);
  }

  protected installRemediation(): string {
    return "Install Claude Code, then run: claude auth login";
  }

  private spawn(options: StartOptions | ResumeOptions, resume: boolean): AgentProcess {
    const argumentsList = [
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...(options.model === null ? [] : ["--model", options.model]),
      ...(options.effort === null ? [] : ["--effort", options.effort]),
      ...(options.yolo
        ? ["--dangerously-skip-permissions"]
        : ["--permission-mode", "dontAsk", "--tools", ""]),
      ...(resume ? ["--resume", (options as ResumeOptions).sessionId] : [])
    ];
    return spawnAgentProcess({
      executable: this.executable,
      arguments: argumentsList,
      cwd: options.cwd,
      prompt: options.prompt,
      parseLine: parseClaudeLine,
      initialSessionId: resume ? (options as ResumeOptions).sessionId : undefined
    });
  }
}
