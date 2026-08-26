import type { ReasoningEffort } from '../config/env.js';

export type RootCauseType = 'link_failure' | 'device_failure' | 'unknown';
export type DeterministicConfidence = 'confirmed' | 'probable' | 'unknown';

export interface DeterministicRootCause {
  type: RootCauseType;
  devices: string[];
  summary: string;
  confidence: DeterministicConfidence;
  evidence: string[];
  predictedUnreachable: string[];
  observedUnreachable: string[];
  predictionMatches: boolean;
}

export interface InvestigableIncident {
  incidentId: string;
  status: 'open' | 'resolved';
  severity: 'critical' | 'warning';
  symptoms: string[];
  affectedDevices: string[];
  eventIds: string[];
  rootCause: DeterministicRootCause;
}

export interface EvidenceEvent {
  id: string;
  deviceId: string;
  eventType: string;
  severity: string;
  source: 'health-service' | 'layer-zero';
  sourceLogId: string | null;
  attributes: Record<string, unknown>;
  occurredAt: string | null;
}

export interface EvidenceLog {
  id: string;
  deviceId: string;
  raw: string;
  daemon: string | null;
  loggedAt: string | null;
}

export interface EvidenceBundle {
  events: EvidenceEvent[];
  logs: EvidenceLog[];
}

export interface PromptRecord {
  version: string;
  developer: string;
  input: string;
}

export interface AgentConclusion {
  rootCauseType: RootCauseType;
  rootCauseDevices: string[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string[];
  citedEventIds: string[];
  citedLogIds: string[];
}

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ModelResult {
  responseId: string;
  responseModel: string;
  conclusion: AgentConclusion;
  usage: ModelUsage;
  latencyMs: number;
  estimatedCostUsd: number;
}

export interface RunClaim {
  runId: string;
  diagnosisVersion: string;
  incident: InvestigableIncident;
  model: string;
  reasoningEffort: ReasoningEffort;
  promptVersion: string;
}

export interface RunCompletion extends ModelResult {
  agreement: 'agree' | 'disagree';
}

export interface AgentRepositoryPort {
  watchIncidents(onIncidents: (incidents: InvestigableIncident[]) => void): () => void;
  claimRun(claim: RunClaim): Promise<boolean>;
  loadEvidence(eventIds: string[]): Promise<EvidenceBundle>;
  markAnalyzing(runId: string, evidence: EvidenceBundle, prompt: PromptRecord): Promise<void>;
  completeRun(runId: string, completion: RunCompletion): Promise<void>;
  failRun(runId: string, error: unknown, latencyMs: number): Promise<void>;
}

export interface InvestigatorClient {
  investigate(prompt: PromptRecord): Promise<ModelResult>;
}
