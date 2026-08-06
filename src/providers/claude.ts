import { execa } from "execa";
import { z } from "zod";
import type { DiagnosticResult } from "../core/types.js";
import { redactSecrets } from "../util/redact.js";
import { BaseAdapter } from "./base.js";
import { parseClaudeLine } from "./parsers.js";
import { spawnAgentProcess } from "./process.js";
import type { AgentProcess, ResumeOptions, StartOptions } from "./types.js";

const authStatusSchema = z.object({ loggedIn: z.boolean() }).passthrough();

export class ClaudeAdapter extends BaseAdapter {
  readonly id = "claude" as const;
  protected readonly executable = "claude";

  async checkAuthenticated(): Promise<DiagnosticResult> {
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
      ...(options.yolo
        ? ["--dangerously-skip-permissions"]
        : ["--permission-mode", "dontAsk", "--tools", "", "--safe-mode"]),
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
