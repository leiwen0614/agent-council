import { describe, expect, it } from "vitest";
import { renderDoctorTable } from "../../src/cli/doctor.js";
import type { CouncilConfig, DiagnosticResult, ProviderId } from "../../src/core/types.js";

const config: CouncilConfig = {
  enabledProviders: ["codex", "claude", "copilot"],
  agents: {
    codex: { yolo: false, model: "gpt-5.6-sol", effort: "xhigh" },
    claude: { yolo: true, model: "claude-opus-4-8", effort: "xhigh" },
    copilot: { yolo: false, model: null, effort: null }
  }
};

function diagnostic(
  provider: ProviderId,
  authenticated: DiagnosticResult = { ok: true, summary: "Authentication is available." }
) {
  return {
    provider,
    installed: { ok: true, summary: "CLI is installed.", version: provider + " 1.0.0" },
    authenticated
  };
}

describe("doctor provider table", () => {
  it("renders agents as columns and configuration dimensions as rows", () => {
    const output = renderDoctorTable(
      config,
      [diagnostic("codex"), diagnostic("claude"), diagnostic("copilot")],
      180
    );
    const lines = output.split("\n");

    expect(lines.find((line) => line.startsWith("Dimension"))).toMatch(/Codex.+Claude.+Copilot/u);
    expect(lines.find((line) => line.startsWith("Status"))).toMatch(/ONLINE.+ONLINE.+ONLINE/u);
    expect(lines.find((line) => line.startsWith("Model"))).toMatch(
      /gpt-5\.6-sol.+claude-opus-4-8.+provider default/u
    );
    expect(lines.find((line) => line.startsWith("Reasoning effort"))).toMatch(
      /xhigh.+xhigh.+provider default/u
    );
    expect(lines.find((line) => line.startsWith("Permission mode"))).toMatch(
      /safe \/ approval.+YOLO \(permission bypass\).+safe \/ approval/u
    );
  });

  it("keeps disabled and offline providers in their columns with remediation", () => {
    const partialConfig: CouncilConfig = { ...config, enabledProviders: ["codex", "claude"] };
    const output = renderDoctorTable(
      partialConfig,
      [
        diagnostic("codex"),
        diagnostic("claude", {
          ok: false,
          summary: "Authentication is missing.",
          remediation: "Run the login command."
        })
      ],
      180
    );
    const lines = output.split("\n");

    expect(lines.find((line) => line.startsWith("Status"))).toMatch(/ONLINE.+OFFLINE.+DISABLED/u);
    expect(output).toContain("Run the login command.");
  });

  it("wraps long values while preserving all three provider columns", () => {
    const output = renderDoctorTable(
      config,
      [diagnostic("codex"), diagnostic("claude"), diagnostic("copilot")],
      72
    );

    expect(output.split("\n").every((line) => line.length <= 72)).toBe(true);
    expect(output).toContain("Codex");
    expect(output).toContain("Claude");
    expect(output).toContain("Copilot");
  });
});
