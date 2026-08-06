import type { DiagnosticResult, ProviderId } from "../core/types.js";

export type StartOptions = {
  prompt: string;
  cwd: string;
  yolo: boolean;
  model: string | null;
  effort: string | null;
  promptPath?: string | undefined;
};

export type ResumeOptions = StartOptions & {
  sessionId: string;
};

export type AgentEvent =
  | { type: "session"; sessionId: string; raw: string }
  | { type: "prose"; text: string; raw: string }
  | { type: "progress"; text: string; raw: string }
  | { type: "diagnostic"; text: string; raw: string };

export type AgentProcessResult = {
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  sessionId: string | null;
  error: string | null;
};

export type AgentProcess = {
  readonly pid: number | undefined;
  readonly events: AsyncIterable<AgentEvent>;
  readonly completion: Promise<AgentProcessResult>;
  cancel(force?: boolean): Promise<void>;
};

export type AgentAdapter = {
  readonly id: ProviderId;
  checkInstalled(): Promise<DiagnosticResult>;
  checkAuthenticated(): Promise<DiagnosticResult>;
  start(options: StartOptions): AgentProcess;
  resume(options: ResumeOptions): AgentProcess;
};

export type ParsedProviderLine = AgentEvent | null;
