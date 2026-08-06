import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { DiagnosticResult } from "../core/types.js";
import { BaseAdapter } from "./base.js";
import { parseCopilotLine } from "./parsers.js";
import { spawnAgentProcess } from "./process.js";
import type { AgentProcess, ResumeOptions, StartOptions } from "./types.js";

const COPILOT_TOKEN_VARIABLES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

function hasEnvironmentAuthentication(environment: NodeJS.ProcessEnv): boolean {
  return COPILOT_TOKEN_VARIABLES.some((name) => (environment[name] ?? "").trim().length > 0);
}

export class CopilotAdapter extends BaseAdapter {
  readonly id = "copilot" as const;
  protected readonly executable = "copilot";

  async checkAuthenticated(): Promise<DiagnosticResult> {
    // Copilot officially supports environment-based authentication. Inspect only presence;
    // credential values must never enter diagnostics or logs.
    if (hasEnvironmentAuthentication(process.env)) {
      return { ok: true, summary: "Copilot authentication is available from the environment." };
    }
    try {
      const home = process.env["COPILOT_HOME"] ?? join(homedir(), ".copilot");
      const content = await readFile(join(home, "config.json"), "utf8");
      const value: unknown = JSON.parse(
        content
          .split(/\r?\n/)
          .filter((line) => !line.trimStart().startsWith("//"))
          .join("\n")
      );
      const schema = z
        .object({
          loggedInUsers: z.array(z.object({ host: z.string().min(1), login: z.string().min(1) }))
        })
        .passthrough();
      const parsed = schema.safeParse(value);
      if (parsed.success && parsed.data.loggedInUsers.length > 0) {
        return { ok: true, summary: "Copilot is authenticated." };
      }
      return {
        ok: false,
        summary: "Copilot authentication is not available.",
        remediation: "Run: copilot login"
      };
    } catch {
      return {
        ok: false,
        summary: "Copilot authentication is not available.",
        remediation: "Run: copilot login"
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
    return "Install GitHub Copilot CLI, then run: copilot login";
  }

  private spawn(options: StartOptions | ResumeOptions, resume: boolean): AgentProcess {
    const prompt =
      options.promptPath === undefined
        ? options.prompt
        : `Read the complete Council stage prompt from ${options.promptPath} using the view tool, then follow it exactly. Treat the file as the user prompt for this turn.`;
    const argumentsList = [
      "--prompt",
      prompt,
      "--output-format",
      "json",
      "--stream",
      "on",
      "--no-ask-user",
      "--no-custom-instructions",
      "--disable-builtin-mcps",
      "--no-auto-update",
      ...(options.yolo
        ? ["--yolo"]
        : options.promptPath === undefined
          ? ["--available-tools="]
          : ["--available-tools=view", "--allow-tool=view"]),
      ...(resume ? [`--resume=${(options as ResumeOptions).sessionId}`] : [])
    ];
    return spawnAgentProcess({
      executable: this.executable,
      arguments: argumentsList,
      cwd: options.cwd,
      prompt,
      promptViaStdin: false,
      parseLine: parseCopilotLine,
      initialSessionId: resume ? (options as ResumeOptions).sessionId : undefined
    });
  }
}
