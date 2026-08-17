import type { CouncilConfig } from "../core/types.js";

export const DEFAULT_CONFIG: CouncilConfig = {
  agents: {
    codex: { yolo: false, model: null, effort: null },
    claude: { yolo: false, model: null, effort: null },
    copilot: { yolo: false, model: null, effort: null }
  },
  enabledProviders: ["codex", "claude", "copilot"]
};
