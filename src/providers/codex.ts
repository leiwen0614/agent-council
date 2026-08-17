import { execa } from "execa";
import { z } from "zod";
import type { DiagnosticResult } from "../core/types.js";
import { redactSecrets } from "../util/redact.js";
import { BaseAdapter } from "./base.js";
import { parseCodexLine } from "./parsers.js";
import { spawnAgentProcess } from "./process.js";
import type { AgentProcess, ResumeOptions, StartOptions } from "./types.js";

const doctorReportSchema = z
  .object({
    checks: z.record(z.unknown())
  })
  .passthrough();

const doctorAuthenticationSchema = z
  .object({
    status: z.string().min(1),
    summary: z.string().min(1),
    remediation: z.string().nullable().optional()
  })
  .passthrough();

const LOGIN_REMEDIATION =
  "Run: codex login, or configure authentication for the active Codex model provider.";

function parseDoctorAuthentication(
  output: string
): z.infer<typeof doctorAuthenticationSchema> | null {
  try {
    const report = doctorReportSchema.safeParse(JSON.parse(output) as unknown);
    if (!report.success) return null;
    const authentication = doctorAuthenticationSchema.safeParse(
      report.data.checks["auth.credentials"]
    );
    return authentication.success ? authentication.data : null;
  } catch {
    return null;
  }
}

export class CodexAdapter extends BaseAdapter {
  readonly id = "codex" as const;
  protected readonly executable = "codex";

  async checkAuthenticated(): Promise<DiagnosticResult> {
    const doctorResult = await this.checkActiveProviderAuthentication();
    if (doctorResult !== null) return doctorResult;

    // Older Codex releases do not expose `doctor --json`; retain their login-status probe.
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
            remediation: LOGIN_REMEDIATION
          };
    } catch {
      return {
        ok: false,
        summary: "Codex authentication could not be checked.",
        remediation: LOGIN_REMEDIATION
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

  private async checkActiveProviderAuthentication(): Promise<DiagnosticResult | null> {
    try {
      const result = await execa(this.executable, ["doctor", "--json"], {
        reject: false,
        shell: false,
        windowsHide: true
      });
      const authentication = parseDoctorAuthentication(result.stdout);
      if (authentication === null) return null;

      const detail = redactSecrets(authentication.summary);
      if (authentication.status === "ok") {
        const openAiLoginNotRequired = /not required/iu.test(authentication.summary);
        return {
          ok: true,
          summary: openAiLoginNotRequired
            ? "Codex is available through the active model provider; OpenAI login is not required."
            : "Codex authentication is available for the active model provider.",
          detail
        };
      }

      return {
        ok: false,
        summary: "Codex authentication is not available for the active model provider.",
        detail,
        remediation:
          authentication.remediation === null || authentication.remediation === undefined
            ? LOGIN_REMEDIATION
            : redactSecrets(authentication.remediation)
      };
    } catch {
      return null;
    }
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
