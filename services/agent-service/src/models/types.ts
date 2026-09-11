import type { ReasoningEffort } from '../config/env.js';

export type RootCauseType =
  | 'configuration_drift'
  | 'routing_session_failure'
  | 'interface_misconfiguration'
  | 'routing_service_failure'
  | 'resource_exhaustion'
  | 'unknown';
export interface InvestigableIncident {
  incidentId: string;
  status: 'open' | 'resolved';
  severity: 'critical' | 'warning';
  startedAt: string | null;
  symptoms: string[];
  affectedDevices: string[];
  eventIds: string[];
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

export interface LabGroundTruth {
  rootCauseType: RootCauseType;
  rootCauseDevices: string[];
}

export interface EvaluationScore {
  typeMatch: boolean;
  devicesMatch: boolean;
  overallMatch: boolean;
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
  groundTruth: LabGroundTruth | null;
  evaluation: EvaluationScore | null;
}

export interface AgentRepositoryPort {
  watchIncidents(onIncidents: (incidents: InvestigableIncident[]) => void): () => void;
  claimRun(claim: RunClaim): Promise<boolean>;
  loadEvidence(eventIds: string[]): Promise<EvidenceBundle>;
  loadGroundTruth(runId: string): Promise<LabGroundTruth | null>;
  markAnalyzing(runId: string, evidence: EvidenceBundle, prompt: PromptRecord): Promise<void>;
  completeRun(runId: string, completion: RunCompletion): Promise<void>;
  failRun(runId: string, error: unknown, latencyMs: number): Promise<void>;
}

export interface InvestigatorClient {
  investigate(prompt: PromptRecord): Promise<ModelResult>;
}
