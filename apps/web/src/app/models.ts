/** Shapes the dashboard reads. Mirrors docs/data-model.md. */

export interface Device {
  id: string;
  name: string;
  type: 'router' | 'host';
  managementAddress: string;
  checkAddress: string;
  enabled: boolean;
}

export interface HealthCheck {
  id: string;
  deviceId: string;
  status: 'healthy' | 'down';
  latencyMs: number | null;
  target: string;
  error: string | null;
  checkedAt: Date | null;
}

export interface NetworkEvent {
  id: string;
  deviceId: string;
  eventType: string;
  severity: 'critical' | 'warning' | 'info';
  attributes: Record<string, unknown>;
  source: 'health-service' | 'layer-zero';
  sourceLogId: string | null;
  occurredAt: Date | null;
}

export interface NetworkLog {
  id: string;
  deviceId: string;
  raw: string;
  daemon: string | null;
  parsed: boolean;
  normalized: boolean;
  source: 'frr' | 'state-observer';
  receivedAt: Date | null;
}

export interface RootCause {
  type:
    | 'configuration_drift'
    | 'routing_session_failure'
    | 'interface_misconfiguration'
    | 'routing_service_failure'
    | 'resource_exhaustion'
    | 'unknown'
    | 'analyzing';
  devices: string[];
  summary: string;
  confidence: 'confirmed' | 'probable' | 'unknown';
  evidence: string[];
  predictedUnreachable: string[];
  observedUnreachable: string[];
  predictionMatches: boolean;
}

export interface Incident {
  id: string;
  incidentId: string;
  status: 'open' | 'resolved';
  severity: 'critical' | 'warning';
  startedAt: Date | null;
  resolvedAt: Date | null;
  affectedDevices: string[];
  unreachableDevices: string[];
  symptoms: string[];
  probableRootCause: string;
  rootCauseType: string;
  rootCause: RootCause | null;
  eventIds: string[];
  eventCount: number;
}

export interface AgentConclusion {
  rootCauseType: Exclude<RootCause['type'], 'analyzing'>;
  rootCauseDevices: string[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string[];
  citedEventIds: string[];
  citedLogIds: string[];
  remediationProposal: {
    tool:
      | 'restore_ospf_cost'
      | 'restore_ospf_adjacency'
      | 'enable_interface'
      | 'restart_routing_service'
      | 'restore_resource_profile'
      | 'escalate_no_safe_action';
    rationale: string;
    citedEvidenceIds: string[];
  };
}

export interface AgentRun {
  id: string;
  runId: string;
  incidentId: string;
  diagnosisVersion: string;
  status: 'running' | 'completed' | 'failed';
  stage: 'collecting_evidence' | 'analyzing' | 'completed' | 'failed';
  provider: 'openai';
  model: string;
  reasoningEffort: string;
  deterministicRootCause: RootCause | null;
  labGroundTruth: {
    rootCauseType: AgentConclusion['rootCauseType'];
    rootCauseDevices: string[];
    expectedRemediationTool: AgentConclusion['remediationProposal']['tool'];
  } | null;
  evaluation: {
    typeMatch: boolean;
    devicesMatch: boolean;
    remediationMatch: boolean;
    overallMatch: boolean;
  } | null;
  conclusion: AgentConclusion | null;
  agreement: 'agree' | 'disagree' | null;
  evidenceEventIds: string[];
  evidenceLogIds: string[];
  citedEventIds: string[];
  citedLogIds: string[];
  promptVersion: string;
  prompt: { developer: string; input: string; version: string } | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  latencyMs: number | null;
  estimatedCostUsd: number | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface LabAction {
  id: string;
  actionId: string;
  scenario:
    | 'configuration-drift'
    | 'routing-session-failure'
    | 'interface-disabled'
    | 'routing-service-crash'
    | 'resource-exhaustion'
    | 'restore';
  label: string;
  status: 'running' | 'completed' | 'failed';
  output: string[];
  exitCode: number | null;
  error: string | null;
  requestedAt: Date | null;
  completedAt: Date | null;
}

/** Latest known state of a device, derived from its most recent health check. */
export interface DeviceState {
  device: Device;
  status: 'healthy' | 'down' | 'unknown';
  latencyMs: number | null;
  checkedAt: Date | null;
}
