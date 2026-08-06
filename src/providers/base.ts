import { execa } from "execa";
import type { DiagnosticResult, ProviderId } from "../core/types.js";
import { errorMessage } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import type { AgentAdapter } from "./types.js";

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: ProviderId;
  protected abstract readonly executable: string;

  abstract checkAuthenticated(): Promise<DiagnosticResult>;
  abstract start(options: Parameters<AgentAdapter["start"]>[0]): ReturnType<AgentAdapter["start"]>;
  abstract resume(
    options: Parameters<AgentAdapter["resume"]>[0]
  ): ReturnType<AgentAdapter["resume"]>;

  async checkInstalled(): Promise<DiagnosticResult> {
    try {
      const result = await execa(this.executable, ["--version"], {
        reject: false,
        shell: false,
        windowsHide: true
      });
      const output = `${result.stdout} ${result.stderr}`.trim();
      if (result.exitCode !== 0) {
        return {
          ok: false,
          summary: `${this.id} CLI is not usable.`,
          detail: redactSecrets(output),
          remediation: this.installRemediation()
        };
      }
      return { ok: true, summary: `${this.id} CLI is installed.`, version: output };
    } catch (error) {
      return {
        ok: false,
        summary: `${this.id} CLI is not installed or not on PATH.`,
        detail: redactSecrets(errorMessage(error)),
        remediation: this.installRemediation()
      };
    }
  }

  protected abstract installRemediation(): string;
}
