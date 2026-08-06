import { describe, expect, it } from "vitest";
import { councilRunSchema } from "../../src/core/schemas.js";

const timestamp = "2026-08-06T12:00:00.000Z";

function providerState(artifact: string) {
  return { status: "waiting" as const, attempts: [], artifact };
}

function stageState(directory: string) {
  return {
    status: "pending" as const,
    startedAt: null,
    finishedAt: null,
    providers: {
      codex: providerState(`${directory}/codex.md`),
      claude: providerState(`${directory}/claude.md`),
      copilot: providerState(`${directory}/copilot.md`)
    }
  };
}

function runWith(reviewMappings: unknown) {
  return {
    schemaVersion: 1,
    id: "2026-08-06T12-00-00-000Z",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    status: "initial_pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    eventSequence: 0,
    degraded: false,
    effectiveConfig: {
      agents: {
        codex: { yolo: false },
        claude: { yolo: false },
        copilot: { yolo: false }
      }
    },
    stages: {
      initial: stageState("answers"),
      review: stageState("reviews"),
      final: stageState("finals")
    },
    reviewMappings,
    degradedContinuations: []
  };
}

describe("councilRunSchema review mappings", () => {
  it("accepts an empty mapping before cross-review", () => {
    expect(councilRunSchema.safeParse(runWith({})).success).toBe(true);
  });

  it("accepts a mapping for only the reviewers prepared so far", () => {
    const result = councilRunSchema.safeParse(
      runWith({
        codex: {
          labels: [
            { label: "Answer A", provider: "claude" },
            { label: "Answer B", provider: "copilot" }
          ],
          displayOrder: ["Answer B", "Answer A"]
        }
      })
    );

    expect(result.success).toBe(true);
  });

  it("rejects unknown reviewer names", () => {
    expect(
      councilRunSchema.safeParse(runWith({ chair: { labels: [], displayOrder: [] } })).success
    ).toBe(false);
  });
});
