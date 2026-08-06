import { z } from "zod";
import { redactSecrets } from "../util/redact.js";
import type { ParsedProviderLine } from "./types.js";

const objectSchema = z.record(z.unknown());

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = objectSchema.safeParse(JSON.parse(line) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    const parsed = objectSchema.safeParse(current);
    if (!parsed.success) return null;
    current = parsed.data[key];
  }
  return typeof current === "string" ? current : null;
}

function diagnostic(line: string): ParsedProviderLine {
  return { type: "diagnostic", text: redactSecrets(line), raw: redactSecrets(line) };
}

export function parseCodexLine(line: string): ParsedProviderLine {
  const raw = redactSecrets(line);
  const value = parseObject(line);
  if (value === null) return diagnostic(line);
  const eventType = stringAt(value, "type");
  if (eventType === "thread.started") {
    const sessionId = stringAt(value, "thread_id");
    return sessionId === null ? diagnostic(line) : { type: "session", sessionId, raw };
  }
  if (eventType === "item.completed" && stringAt(value, "item", "type") === "agent_message") {
    const text = stringAt(value, "item", "text");
    return text === null ? diagnostic(line) : { type: "prose", text, raw };
  }
  if (eventType === "error" || eventType === "turn.failed") {
    return { type: "diagnostic", text: redactSecrets(stringAt(value, "message") ?? line), raw };
  }
  if (eventType === "item.started" || eventType === "item.completed") {
    const text = stringAt(value, "item", "type");
    return text === null ? null : { type: "progress", text, raw };
  }
  return null;
}

export function parseClaudeLine(line: string): ParsedProviderLine {
  const raw = redactSecrets(line);
  const value = parseObject(line);
  if (value === null) return diagnostic(line);
  const eventType = stringAt(value, "type");
  if (eventType === "system" && stringAt(value, "subtype") === "init") {
    const sessionId = stringAt(value, "session_id");
    return sessionId === null ? null : { type: "session", sessionId, raw };
  }
  if (eventType === "stream_event" && stringAt(value, "event", "type") === "content_block_delta") {
    const text = stringAt(value, "event", "delta", "text");
    return text === null ? null : { type: "prose", text, raw };
  }
  // With partial streaming enabled, the final assistant event duplicates all text deltas.
  if (eventType === "assistant") return null;
  if (eventType === "result") {
    const sessionId = stringAt(value, "session_id");
    if (sessionId !== null) return { type: "session", sessionId, raw };
  }
  return null;
}

export function parseCopilotLine(line: string): ParsedProviderLine {
  const raw = redactSecrets(line);
  const value = parseObject(line);
  if (value === null) return diagnostic(line);
  const eventType = stringAt(value, "type");
  if (eventType === "assistant.message_delta") {
    const text = stringAt(value, "data", "deltaContent");
    return text === null ? null : { type: "prose", text, raw };
  }
  if (eventType === "result") {
    const sessionId = stringAt(value, "sessionId");
    return sessionId === null ? diagnostic(line) : { type: "session", sessionId, raw };
  }
  if (eventType === "tool.execution_start" || eventType === "assistant.reasoning_delta") {
    return { type: "progress", text: eventType, raw };
  }
  return null;
}
