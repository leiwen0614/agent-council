import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { execa } from "execa";
import { terminateProcessTree } from "../orchestration/cancellation.js";
import { errorMessage } from "../util/errors.js";
import { redactSecrets } from "../util/redact.js";
import type { AgentEvent, AgentProcess, AgentProcessResult, ParsedProviderLine } from "./types.js";

export type SpawnSpecification = {
  executable: string;
  arguments: string[];
  cwd: string;
  prompt: string;
  promptViaStdin?: boolean | undefined;
  parseLine: (line: string) => ParsedProviderLine;
  initialSessionId?: string | undefined;
};

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private readonly queued: AgentEvent[] = [];
  private readonly waiters: ((value: IteratorResult<AgentEvent>) => void)[] = [];
  private ended = false;

  push(event: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value: event });
    else this.queued.push(event);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: async () => {
        const event = this.queued.shift();
        if (event !== undefined) return { done: false, value: event };
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<AgentEvent>>((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

function consumeLines(stream: Readable | null, onLine: (line: string) => void): Promise<void> {
  if (stream === null) return Promise.resolve();
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  reader.on("line", onLine);
  return new Promise((resolve) => reader.once("close", resolve));
}

function parseSafely(line: string, parser: SpawnSpecification["parseLine"]): ParsedProviderLine {
  try {
    return parser(line);
  } catch (error) {
    const raw = redactSecrets(line);
    return {
      type: "diagnostic",
      text: `Provider output could not be parsed: ${redactSecrets(errorMessage(error))}`,
      raw
    };
  }
}

type ProcessResultInput = {
  exitCode?: number | undefined;
  signal?: string | undefined;
  isCanceled: boolean;
  isTerminated: boolean;
  failed: boolean;
  shortMessage?: string | undefined;
};

function processResult(result: ProcessResultInput, sessionId: string | null): AgentProcessResult {
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    cancelled: result.isCanceled || result.isTerminated,
    sessionId,
    error: result.failed ? redactSecrets(result.shortMessage ?? "Provider process failed.") : null
  };
}

export function spawnAgentProcess(specification: SpawnSpecification): AgentProcess {
  const queue = new AsyncEventQueue();
  let sessionId: string | null = specification.initialSessionId ?? null;
  const subprocess = execa(specification.executable, specification.arguments, {
    cwd: specification.cwd,
    ...(specification.promptViaStdin === false ? {} : { input: specification.prompt }),
    shell: false,
    reject: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdout: "pipe",
    stderr: "pipe"
  });

  const output = consumeLines(subprocess.stdout, (line) => {
    const event = parseSafely(line, specification.parseLine);
    if (event !== null) {
      if (event.type === "session") sessionId = event.sessionId;
      queue.push(event);
    }
  });
  const errors = consumeLines(subprocess.stderr, (line) => {
    const redacted = redactSecrets(line);
    queue.push({ type: "diagnostic", text: redacted, raw: redacted });
  });
  const completion = (async (): Promise<AgentProcessResult> => {
    try {
      const result = await subprocess;
      await Promise.all([output, errors]);
      return processResult(result, sessionId);
    } catch (error) {
      return {
        exitCode: null,
        signal: null,
        cancelled: false,
        sessionId,
        error: redactSecrets(errorMessage(error))
      };
    } finally {
      queue.end();
    }
  })();

  return {
    pid: subprocess.pid,
    events: queue,
    completion,
    async cancel(force = false) {
      const pid = subprocess.pid;
      if (pid !== undefined) await terminateProcessTree(pid, force);
    }
  };
}
