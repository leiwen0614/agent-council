import type { CouncilConfig } from "../core/types.js";

export const DEFAULT_CONFIG: CouncilConfig = {
  agents: {
    codex: { yolo: false },
    claude: { yolo: false },
    copilot: { yolo: false }
  },
  ui: {
    maxPanelLines: 18
  }
};
