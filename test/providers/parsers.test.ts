import { describe, expect, it } from "vitest";
import { parseClaudeLine, parseCodexLine, parseCopilotLine } from "../../src/providers/parsers.js";

describe("provider JSONL parsers", () => {
  it("extracts Codex sessions and completed agent prose", () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"thread-1"}')).toMatchObject({
      type: "session",
      sessionId: "thread-1"
    });
    expect(
      parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}')
    ).toMatchObject({ type: "prose", text: "answer" });
  });

  it("extracts Claude stream deltas and session identifiers", () => {
    expect(
      parseClaudeLine('{"type":"system","subtype":"init","session_id":"claude-1"}')
    ).toMatchObject({ type: "session", sessionId: "claude-1" });
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"delta"}}}'
      )
    ).toMatchObject({ type: "prose", text: "delta" });
  });

  it("extracts Copilot deltas and result session identifiers", () => {
    expect(
      parseCopilotLine('{"type":"assistant.message_delta","data":{"deltaContent":"piece"}}')
    ).toMatchObject({ type: "prose", text: "piece" });
    expect(
      parseCopilotLine('{"type":"result","sessionId":"copilot-1","exitCode":0}')
    ).toMatchObject({ type: "session", sessionId: "copilot-1" });
  });

  it("treats malformed external output as a redacted diagnostic", () => {
    expect(parseCodexLine("authorization=super-secret-token")).toEqual({
      type: "diagnostic",
      text: "[REDACTED]",
      raw: "[REDACTED]"
    });
  });

  it("ignores valid but irrelevant events", () => {
    expect(parseCopilotLine('{"type":"assistant.idle","data":{}}')).toBeNull();
  });
});
