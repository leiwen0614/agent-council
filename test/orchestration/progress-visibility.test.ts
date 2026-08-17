import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilConfig, ProviderId } from "../../src/core/types.js";
import type { LiveSnapshot } from "../../src/ui/live.js";

const liveViewState = vi.hoisted(() => ({
  completed: [] as LiveSnapshot[],
  updates: [] as LiveSnapshot[]
}));

vi.mock("../../src/ui/live.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ui/live.js")>();
  return {
    ...actual,
    createLiveView(initial: LiveSnapshot) {
      let latest = actual.cloneLiveSnapshot(initial);
      liveViewState.updates.push(latest);
      return {
        update(snapshot: LiveSnapshot) {
          latest = actual.cloneLiveSnapshot(snapshot);
          liveViewState.updates.push(latest);
        },
        close(options?: { preserveCompleteOutput?: boolean }) {
          if (options?.preserveCompleteOutput !== false) liveViewState.completed.push(latest);
          return Promise.resolve();
        }
      };
    }
  };
});

import { CouncilEngine } from "../../src/orchestration/council.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentProcess,
  AgentProcessResult,
  StartOptions
} from "../../src/providers/index.js";
import { CouncilRepository } from "../../src/storage/repository.js";

const temporaryDirectories: string[] = [];
const config: CouncilConfig = {
  enabledProviders: ["codex", "copilot"],
  agents: {
    codex: { yolo: false, model: null, effort: null },
    claude: { yolo: false, model: null, effort: null },
    copilot: { yolo: false, model: null, effort: null }
  }
};

function processWithHiddenProgress(provider: ProviderId): AgentProcess {
  const sessionId = `${provider}-session`;
  const hiddenProgress: AgentEvent[] =
    provider === "codex"
      ? [
          {
            type: "progress",
            text: "command_execution",
            raw: "command_execution",
            visible: false
          }
        ]
      : [
          {
            type: "progress",
            text: "tool.execution_start",
            raw: "tool.execution_start",
            visible: false
          },
          {
            type: "progress",
            text: "assistant.reasoning_delta",
            raw: "assistant.reasoning_delta",
            visible: false
          }
        ];
  async function* events(): AsyncGenerator<AgentEvent> {
    yield await Promise.resolve({ type: "session", sessionId, raw: "session" } as const);
    for (const event of hiddenProgress) yield await Promise.resolve(event);
    yield await Promise.resolve({
      type: "prose",
      text: `${provider} answer`,
      raw: "prose"
    } as const);
  }
  const result: AgentProcessResult = {
    exitCode: 0,
    signal: null,
    cancelled: false,
    sessionId,
    error: null
  };
  return {
    pid: undefined,
    events: events(),
    completion: Promise.resolve(result),
    cancel: () => Promise.resolve()
  };
}

class HiddenProgressAdapter implements AgentAdapter {
  constructor(readonly id: ProviderId) {}
  checkInstalled() {
    return Promise.resolve({ ok: true, summary: "installed" });
  }
  checkAuthenticated() {
    return Promise.resolve({ ok: true, summary: "authenticated" });
  }
  start(options: StartOptions) {
    void options;
    return processWithHiddenProgress(this.id);
  }
  resume(options: StartOptions) {
    void options;
    return processWithHiddenProgress(this.id);
  }
}

beforeEach(() => {
  liveViewState.completed.length = 0;
  liveViewState.updates.length = 0;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("provider progress visibility", () => {
  it("persists hidden lifecycle progress without showing it in live or completed panels", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-council-progress-visibility-"));
    temporaryDirectories.push(root);
    const repository = new CouncilRepository(root);
    const session = await repository.createSession("progress visibility");
    const adapters = {
      codex: new HiddenProgressAdapter("codex"),
      claude: new HiddenProgressAdapter("claude"),
      copilot: new HiddenProgressAdapter("copilot")
    };
    const engine = new CouncilEngine({
      repository,
      config,
      adapters,
      recover: () => Promise.resolve("abandon")
    });

    const run = await engine.start(session, "Hide provider lifecycle noise.");
    const events = await repository.readEvents(run);
    const progressText = events
      .filter((event) => event.kind === "provider.progress")
      .map((event) => event.text);

    expect(progressText).toContain("command_execution");
    expect(progressText).toContain("tool.execution_start");
    expect(progressText).toContain("assistant.reasoning_delta");
    expect(liveViewState.updates.some((snapshot) => snapshot.panels.codex.text.length > 0)).toBe(
      true
    );
    expect(liveViewState.completed).toHaveLength(3);
    for (const snapshot of [...liveViewState.updates, ...liveViewState.completed]) {
      for (const provider of snapshot.providers) {
        expect(snapshot.panels[provider].text).not.toMatch(
          /command_execution|tool\.execution_start|assistant\.reasoning_delta/u
        );
      }
    }
  });
});
