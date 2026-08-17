export const PROVIDERS = ["codex", "claude", "copilot"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const STAGES = ["initial", "review", "final"] as const;
export type Stage = (typeof STAGES)[number];

export type ProviderStatus =
  "waiting" | "running" | "completed" | "failed" | "cancelled" | "blocked_by_approval" | "skipped";

export type StageStatus = "pending" | "running" | "completed" | "partial" | "cancelled";

export type RunStatus =
  | "initial_pending"
  | "initial_running"
  | "initial_recovery"
  | "review_pending"
  | "review_running"
  | "review_recovery"
  | "final_pending"
  | "final_running"
  | "final_recovery"
  | "awaiting_decision"
  | "completed"
  | "abandoned";

export type ProviderConfig = {
  yolo: boolean;
  model: string | null;
  effort: string | null;
};

export type CouncilConfig = {
  agents: Record<ProviderId, ProviderConfig>;
  enabledProviders: ProviderId[];
};

export type DiagnosticResult = {
  ok: boolean;
  summary: string;
  detail?: string | undefined;
  remediation?: string | undefined;
  version?: string | undefined;
};

export type ProviderSession = {
  sessionId: string | null;
  updatedAt: string;
};

export type CouncilSession = {
  schemaVersion: 1;
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  originalProjectRoot: string;
  activeRunId: string | null;
  providers: Record<ProviderId, ProviderSession>;
};

export type ProviderAttempt = {
  number: number;
  status: Exclude<ProviderStatus, "waiting" | "running" | "skipped">;
  startedAt: string;
  finishedAt: string;
  error?: string | undefined;
};

export type ProviderStageState = {
  status: ProviderStatus;
  attempts: ProviderAttempt[];
  artifact: string;
  error?: string | undefined;
};

export type StageState = {
  status: StageStatus;
  startedAt: string | null;
  finishedAt: string | null;
  providers: Record<ProviderId, ProviderStageState>;
};

export type ReviewLabel = {
  label: string;
  provider: ProviderId;
};

export type ReviewMapping = {
  labels: ReviewLabel[];
  displayOrder: string[];
};

export type ReviewMappings = Partial<Record<ProviderId, ReviewMapping | undefined>>;

export type EvidenceRecord = {
  stage: Stage;
  continuedAt: string;
  included: string[];
  omitted: string[];
};

export type EffectiveRunConfig = {
  agents: Record<ProviderId, ProviderConfig>;
  enabledProviders: ProviderId[];
};

export type CouncilRun = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  eventSequence: number;
  degraded: boolean;
  effectiveConfig: EffectiveRunConfig;
  stages: Record<Stage, StageState>;
  reviewMappings: ReviewMappings;
  degradedContinuations: EvidenceRecord[];
};

export type CouncilDecision = {
  schemaVersion: 1;
  selectedAgent: ProviderId | null;
  decision: string;
  sources: string[];
  decidedAt: string;
};

export type CouncilEventKind =
  | "stage.started"
  | "stage.completed"
  | "stage.partial"
  | "provider.started"
  | "provider.progress"
  | "provider.prose"
  | "provider.completed"
  | "provider.failed"
  | "provider.cancelled"
  | "provider.skipped"
  | "diagnostic";

export type CouncilEvent = {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  sessionId: string;
  runId: string;
  stage: Stage;
  provider: ProviderId | null;
  kind: CouncilEventKind;
  text?: string | undefined;
  metadata?: Record<string, string | number | boolean | null> | undefined;
};

export type NewCouncilEvent = Omit<CouncilEvent, "schemaVersion" | "sequence" | "timestamp">;

export type RecoveryAction = "retry" | "continue" | "abandon" | "defer";

export type DecisionInput =
  | { type: "select"; provider: ProviderId; note?: string | undefined }
  | { type: "mixed"; decision: string; providers: ProviderId[] }
  | { type: "defer" };
