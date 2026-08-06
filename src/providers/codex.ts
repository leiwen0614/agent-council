import { execa } from "execa";
import type { DiagnosticResult } from "../core/types.js";
import { redactSecrets } from "../util/redact.js";
import { BaseAdapter } from "./base.js";
import { parseCodexLine } from "./parsers.js";
import { spawnAgentProcess } from "./process.js";
import type { AgentProcess, ResumeOptions, StartOptions } from "./types.js";

export class CodexAdapter extends BaseAdapter {
  readonly id = "codex" as const;
  protected readonly executable = "codex";

  async checkAuthenticated(): Promise<DiagnosticResult> {
    try {
      const result = await execa(this.executable, ["login", "status"], {
        reject: false,
        shell: false,
        windowsHide: true
      });
      const detail = redactSecrets(`${result.stdout} ${result.stderr}`.trim());
      return result.exitCode === 0
        ? { ok: true, summary: "Codex is authenticated.", detail }
        : {
            ok: false,
            summary: "Codex is not authenticated.",
            detail,
            remediation: "Run: codex login"
          };
    } catch {
      return {
        ok: false,
        summary: "Codex authentication could not be checked.",
        remediation: "Run: codex login"
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
    return "Install the official Codex CLI, then run: codex login";
  }

  private spawn(options: StartOptions | ResumeOptions, resume: boolean): AgentProcess {
    const modelArguments = options.model === null ? [] : ["--model", options.model];
    const effortArguments =
      options.effort === null
        ? []
        : ["--config", `model_reasoning_effort=${JSON.stringify(options.effort)}`];
    const permissionArguments = options.yolo
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : resume
        ? ["--config", 'sandbox_mode="read-only"']
        : ["--sandbox", "read-only"];
    const argumentsList = resume
      ? [
          "exec",
          "resume",
          ...modelArguments,
          ...effortArguments,
          ...permissionArguments,
          "--json",
          (options as ResumeOptions).sessionId,
          "-"
        ]
      : [
          "exec",
          ...modelArguments,
          ...effortArguments,
          ...permissionArguments,
          "--color",
          "never",
          "--json",
          "-"
        ];
    return spawnAgentProcess({
      executable: this.executable,
      arguments: argumentsList,
      cwd: options.cwd,
      prompt: options.prompt,
      parseLine: parseCodexLine,
      initialSessionId: resume ? (options as ResumeOptions).sessionId : undefined
    });
  }
}
