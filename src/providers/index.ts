import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CopilotAdapter } from "./copilot.js";
import type { AgentAdapter } from "./types.js";

export * from "./types.js";
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
export { CopilotAdapter } from "./copilot.js";

export function createProviderAdapters(): Record<"codex" | "claude" | "copilot", AgentAdapter> {
  return { codex: new CodexAdapter(), claude: new ClaudeAdapter(), copilot: new CopilotAdapter() };
}
