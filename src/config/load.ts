import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { councilConfigSchema, partialCouncilConfigSchema } from "../core/schemas.js";
import type { CouncilConfig, ProviderId } from "../core/types.js";
import { CouncilError, errorMessage } from "../util/errors.js";
import { DEFAULT_CONFIG } from "./defaults.js";

type PartialCouncilConfig = ReturnType<typeof partialCouncilConfigSchema.parse>;

function userConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32" && environment["APPDATA"]) {
    return join(environment["APPDATA"], "agent-council", "config.yaml");
  }
  const configHome = environment["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(configHome, "agent-council", "config.yaml");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readConfigFile(path: string): Promise<PartialCouncilConfig> {
  try {
    const value: unknown = parse(await readFile(path, "utf8"));
    const result = partialCouncilConfigSchema.safeParse(value);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
        .join("; ");
      throw new CouncilError("CONFIG_INVALID", `Configuration in ${path} is invalid: ${details}`);
    }
    return result.data;
  } catch (error) {
    if (error instanceof CouncilError) {
      throw error;
    }
    throw new CouncilError("CONFIG_INVALID", `Could not parse ${path}: ${errorMessage(error)}`, {
      cause: error
    });
  }
}

function mergeConfig(base: CouncilConfig, override: PartialCouncilConfig): CouncilConfig {
  return {
    agents: {
      codex: { yolo: override.agents?.codex?.yolo ?? base.agents.codex.yolo },
      claude: { yolo: override.agents?.claude?.yolo ?? base.agents.claude.yolo },
      copilot: { yolo: override.agents?.copilot?.yolo ?? base.agents.copilot.yolo }
    },
    ui: { maxPanelLines: override.ui?.maxPanelLines ?? base.ui.maxPanelLines }
  };
}

export async function loadConfig(projectRoot: string): Promise<CouncilConfig> {
  const paths = [userConfigPath(), join(projectRoot, "council.config.yaml")];
  let config = structuredClone(DEFAULT_CONFIG);

  for (const path of paths) {
    if (await fileExists(path)) {
      config = mergeConfig(config, await readConfigFile(path));
    }
  }

  const result = councilConfigSchema.safeParse(config);
  if (!result.success) {
    throw new CouncilError(
      "CONFIG_INVALID",
      result.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return result.data;
}

export function withYoloOverrides(config: CouncilConfig, providers: ProviderId[]): CouncilConfig {
  const copy = structuredClone(config);
  for (const provider of providers) {
    copy.agents[provider].yolo = true;
  }
  return copy;
}

export const configLocations = { userConfigPath };
