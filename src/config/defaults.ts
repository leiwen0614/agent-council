import type { CouncilConfig } from "../core/types.js";

export const DEFAULT_CONFIG: CouncilConfig = {
  agents: {
    codex: { yolo: false },
    claude: { yolo: false },
    copilot: { yolo: false }
  },
  enabledProviders: ["codex", "claude", "copilot"],
  ui: {
    maxPanelLines: 18
  }
};
