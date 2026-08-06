import { checkbox, confirm, editor, input, select } from "@inquirer/prompts";
import { PROVIDERS, type CouncilSession, type ProviderId, type Stage } from "../core/types.js";

export type RecoveryChoice = "retry" | "continue" | "abandon";
export type DecisionChoice =
  | { kind: "select"; provider: ProviderId; note: string | null }
  | { kind: "mixed"; providers: ProviderId[]; decision: string }
  | { kind: "defer" };

export async function askPrompt(): Promise<string> {
  const value = await editor({
    message: "Enter the Council prompt",
    waitForUserInput: false,
    validate: (answer) => answer.trim().length > 0 || "The prompt cannot be empty."
  });
  return value;
}

export async function askSessionName(): Promise<string | null> {
  const value = await input({ message: "Session name (optional)" });
  return value.trim().length === 0 ? null : value.trim();
}

export async function chooseSession(sessions: CouncilSession[]): Promise<CouncilSession> {
  return select({
    message: "Choose a Council session",
    choices: sessions.map((session) => ({
      name: `${session.name ?? "Unnamed"} (${session.id.slice(0, 8)})`,
      value: session,
      description: `Updated ${session.updatedAt}`
    }))
  });
}

export async function chooseHomeAction(hasSessions: boolean): Promise<"new" | "resume" | "doctor"> {
  return select({
    message: "Agent Council",
    choices: [
      { name: "Start a new Council session", value: "new" as const },
      ...(hasSessions ? [{ name: "Resume a Council session", value: "resume" as const }] : []),
      { name: "Run provider diagnostics", value: "doctor" as const }
    ]
  });
}

export async function chooseRecovery(stage: Stage, canContinue: boolean): Promise<RecoveryChoice> {
  return select({
    message: `${stage} stage is incomplete. Choose a recovery action`,
    choices: [
      { name: "Retry failed, cancelled, or missing providers", value: "retry" as const },
      ...(canContinue
        ? [{ name: "Continue explicitly with completed evidence", value: "continue" as const }]
        : []),
      { name: "Abandon this run and preserve its artifacts", value: "abandon" as const }
    ]
  });
}

export async function chooseDecision(available: ProviderId[]): Promise<DecisionChoice> {
  const action = await select<ProviderId | "mixed" | "defer">({
    message: "Record the Council decision",
    choices: [
      ...available.map((provider) => ({
        name: `Select ${provider} final report`,
        value: provider
      })),
      { name: "Record a mixed decision", value: "mixed" },
      { name: "Defer the decision", value: "defer" }
    ]
  });
  if (action === "defer") return { kind: "defer" };
  if (action !== "mixed") {
    const note = await input({ message: "Decision note (optional)" });
    return { kind: "select", provider: action, note: note.trim() || null };
  }
  const providers = await checkbox({
    message: "Select final reports used by the mixed decision",
    choices: available.map((provider) => ({ name: provider, value: provider })),
    required: true
  });
  const decision = await editor({
    message: "Describe the mixed decision",
    waitForUserInput: false,
    validate: (answer) => answer.trim().length > 0 || "A mixed decision cannot be empty."
  });
  return { kind: "mixed", providers, decision: decision.trim() };
}

export async function confirmRun(message: string): Promise<boolean> {
  return confirm({ message, default: true });
}

export function parseProviders(value: string): ProviderId[] {
  if (value.trim().length === 0) return [];
  const values = value.split(",").map((item) => item.trim().toLowerCase());
  const invalid = values.filter((item) => !PROVIDERS.includes(item as ProviderId));
  if (invalid.length > 0) throw new Error(`Unknown provider(s): ${invalid.join(", ")}`);
  return [...new Set(values as ProviderId[])];
}

export function parseCouncilProviders(value: string): ProviderId[] {
  const providers = parseProviders(value);
  if (providers.length < 2) throw new Error("Agent Council requires at least two providers.");
  return providers;
}
