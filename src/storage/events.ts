import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { councilEventSchema } from "../core/schemas.js";
import type { CouncilEvent, NewCouncilEvent } from "../core/types.js";
import { CouncilError, errorMessage } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import { nowIso } from "../util/time.js";

export type EventLogContext = {
  sessionId: string;
  runId: string;
};

export type EventLogSnapshot = {
  events: CouncilEvent[];
  needsLineBreakBeforeAppend: boolean;
};

const SENSITIVE_METADATA_KEY =
  /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|credential)/i;

function storageError(code: string, path: string, detail: string, cause?: unknown): CouncilError {
  return new CouncilError(
    code,
    "Invalid event log " + path + ": " + detail,
    cause === undefined ? undefined : { cause }
  );
}

function sanitizeMetadata(metadata: NewCouncilEvent["metadata"]): NewCouncilEvent["metadata"] {
  if (metadata === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "string"
        ? SENSITIVE_METADATA_KEY.test(key)
          ? "[REDACTED]"
          : redactSecrets(value)
        : value
    ])
  );
}

export function createCouncilEvent(input: NewCouncilEvent, sequence: number): CouncilEvent {
  return councilEventSchema.parse({
    ...input,
    schemaVersion: 1,
    sequence,
    timestamp: nowIso(),
    ...(input.text === undefined ? {} : { text: redactSecrets(input.text) }),
    ...(input.metadata === undefined ? {} : { metadata: sanitizeMetadata(input.metadata) })
  });
}

/**
 * Reads and validates the complete JSONL prefix. A syntactically torn final line can be
 * removed during append recovery; complete but invalid records are never hidden.
 */
export async function inspectEventLog(
  path: string,
  context: EventLogContext,
  repairTornFinalLine = false
): Promise<EventLogSnapshot> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return { events: [], needsLineBreakBeforeAppend: false };
    }
    throw new CouncilError(
      "STORAGE_READ_FAILED",
      "Could not read " + path + ": " + errorMessage(error),
      { cause: error }
    );
  }

  if (content.length === 0) {
    return { events: [], needsLineBreakBeforeAppend: false };
  }

  const endsWithLineBreak = content.endsWith("\n");
  const splitLines = content.split("\n");
  const lines = endsWithLineBreak ? splitLines.slice(0, -1) : splitLines;
  const events: CouncilEvent[] = [];
  let validPrefixBytes = 0;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const isUnterminatedFinalLine = index === lines.length - 1 && !endsWithLineBreak;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (repairTornFinalLine && isUnterminatedFinalLine) {
        await truncate(path, validPrefixBytes);
        return { events, needsLineBreakBeforeAppend: false };
      }
      throw storageError(
        "STORAGE_EVENT_INVALID",
        path,
        "line " + String(lineNumber) + " is not valid JSON: " + errorMessage(error),
        error
      );
    }

    const parsed = councilEventSchema.safeParse(value);
    if (!parsed.success) {
      throw storageError(
        "STORAGE_EVENT_SCHEMA_INVALID",
        path,
        "line " +
          String(lineNumber) +
          " has an invalid schema: " +
          parsed.error.issues.map((issue) => issue.message).join("; ")
      );
    }

    const event = parsed.data;
    const expectedSequence = events.length + 1;
    if (event.sequence !== expectedSequence) {
      throw storageError(
        "STORAGE_EVENT_SEQUENCE_INVALID",
        path,
        "line " +
          String(lineNumber) +
          " has sequence " +
          String(event.sequence) +
          "; expected " +
          String(expectedSequence)
      );
    }
    if (event.sessionId !== context.sessionId || event.runId !== context.runId) {
      throw storageError(
        "STORAGE_EVENT_CONTEXT_INVALID",
        path,
        "line " + String(lineNumber) + " belongs to a different Council session or run"
      );
    }

    events.push(event);
    validPrefixBytes += Buffer.byteLength(line + "\n", "utf8");
  }

  return {
    events,
    needsLineBreakBeforeAppend: events.length > 0 && !endsWithLineBreak
  };
}

export async function appendEventRecord(
  path: string,
  event: CouncilEvent,
  needsLineBreakBeforeAppend: boolean
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const prefix = needsLineBreakBeforeAppend ? "\n" : "";
  await appendFile(path, prefix + JSON.stringify(event) + "\n", "utf8");
}
