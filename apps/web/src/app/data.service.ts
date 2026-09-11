import { Injectable, computed, signal } from '@angular/core';
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  type DocumentData,
  type Query,
} from 'firebase/firestore';
import { db } from './firebase';
import type {
  AgentConclusion,
  AgentRun,
  Device,
  DeviceState,
  HealthCheck,
  Incident,
  LabAction,
  NetworkEvent,
  NetworkLog,
  RootCause,
} from './models';

/**
 * Live view of the ACN Firestore collections.
 *
 * Everything is an onSnapshot listener, so the dashboard updates as the lab
 * changes rather than polling. Break the R2-R3 link in a terminal and the page
 * reacts within a check interval - which is the point of having a UI at all.
 *
 * Strictly read-only. The security rules deny client writes; nothing here
 * attempts one.
 */
@Injectable({ providedIn: 'root' })
export class DataService {
  readonly devices = signal<Device[]>([]);
  readonly healthChecks = signal<HealthCheck[]>([]);
  readonly events = signal<NetworkEvent[]>([]);
  readonly incidents = signal<Incident[]>([]);
  readonly agentRuns = signal<AgentRun[]>([]);
  readonly labActions = signal<LabAction[]>([]);
  readonly logs = signal<NetworkLog[]>([]);
  readonly connected = signal(false);
  readonly error = signal<string | null>(null);

  /** Most recent check per device, which is what an operator actually wants. */
  readonly deviceStates = computed<DeviceState[]>(() => {
    const latest = new Map<string, HealthCheck>();

    for (const check of this.healthChecks()) {
      const existing = latest.get(check.deviceId);
      const newer =
        existing === undefined ||
        (check.checkedAt?.getTime() ?? 0) > (existing.checkedAt?.getTime() ?? 0);
      if (newer) latest.set(check.deviceId, check);
    }

    return this.devices().map((device) => {
      const check = latest.get(device.id);
      return {
        device,
        status: check?.status ?? 'unknown',
        latencyMs: check?.latencyMs ?? null,
        checkedAt: check?.checkedAt ?? null,
      };
    });
  });

  readonly openIncidents = computed(() =>
    this.incidents().filter((incident) => incident.status === 'open'),
  );

  private started = false;

  /** Attach every listener. Safe to call more than once. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const store = db();

    this.listen(
      query(collection(store, 'devices')),
      (docs) => this.devices.set(docs.map(toDevice).sort((a, b) => a.id.localeCompare(b.id))),
    );

    // Bounded: healthChecks is append-only and grows without limit, so the
    // dashboard reads a recent slice rather than the whole history.
    this.listen(
      query(collection(store, 'healthChecks'), orderBy('checkedAt', 'desc'), limit(200)),
      (docs) => this.healthChecks.set(docs.map(toHealthCheck)),
    );

    this.listen(
      query(collection(store, 'networkEvents'), orderBy('occurredAt', 'desc'), limit(200)),
      (docs) => this.events.set(docs.map(toEvent)),
    );

    this.listen(
      query(collection(store, 'incidents'), orderBy('startedAt', 'desc'), limit(50)),
      (docs) => this.incidents.set(docs.map(toIncident)),
    );

    this.listen(
      query(collection(store, 'agentRuns'), orderBy('startedAt', 'desc'), limit(50)),
      (docs) => this.agentRuns.set(docs.map(toAgentRun)),
    );

    this.listen(
      query(collection(store, 'labActions'), orderBy('requestedAt', 'desc'), limit(50)),
      (docs) => this.labActions.set(docs.map(toLabAction)),
    );

    this.listen(
      query(collection(store, 'networkLogs'), orderBy('receivedAt', 'desc'), limit(300)),
      (docs) => this.logs.set(docs.map(toLog)),
    );
  }

  /** The raw log line behind an event, when it came from one. */
  logFor(sourceLogId: string | null): NetworkLog | undefined {
    if (sourceLogId === null) return undefined;
    return this.logs().find((log) => log.id === sourceLogId);
  }

  eventFor(eventId: string): NetworkEvent | undefined {
    return this.events().find((event) => event.id === eventId);
  }

  eventsFor(incident: Incident): NetworkEvent[] {
    const ids = new Set(incident.eventIds);
    return this.events()
      .filter((event) => ids.has(event.id))
      .sort((a, b) => (a.occurredAt?.getTime() ?? 0) - (b.occurredAt?.getTime() ?? 0));
  }

  private listen(
    q: Query<DocumentData>,
    apply: (docs: { id: string; data: DocumentData }[]) => void,
  ): void {
    onSnapshot(
      q,
      (snapshot) => {
        this.connected.set(true);
        this.error.set(null);
        apply(snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() })));
      },
      (error) => {
        // A dead listener looks exactly like a quiet network, so say so plainly
        // rather than showing an empty dashboard that implies all is well.
        this.connected.set(false);
        this.error.set(error.message);
      },
    );
  }
}

function toDate(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toDevice({ id, data }: { id: string; data: DocumentData }): Device {
  return {
    id,
    name: str(data['name'], id),
    type: data['type'] === 'host' ? 'host' : 'router',
    managementAddress: str(data['managementAddress']),
    checkAddress: str(data['checkAddress']),
    enabled: data['enabled'] !== false,
  };
}

function toHealthCheck({ id, data }: { id: string; data: DocumentData }): HealthCheck {
  return {
    id,
    deviceId: str(data['deviceId']),
    status: data['status'] === 'down' ? 'down' : 'healthy',
    latencyMs: typeof data['latencyMs'] === 'number' ? data['latencyMs'] : null,
    target: str(data['target']),
    error: typeof data['error'] === 'string' ? data['error'] : null,
    checkedAt: toDate(data['checkedAt']),
  };
}

function toEvent({ id, data }: { id: string; data: DocumentData }): NetworkEvent {
  const severity = str(data['severity'], 'info');
  return {
    id,
    deviceId: str(data['deviceId']),
    eventType: str(data['eventType']),
    severity: severity === 'critical' || severity === 'warning' ? severity : 'info',
    attributes:
      typeof data['attributes'] === 'object' && data['attributes'] !== null
        ? (data['attributes'] as Record<string, unknown>)
        : {},
    source: data['source'] === 'layer-zero' ? 'layer-zero' : 'health-service',
    sourceLogId: typeof data['sourceLogId'] === 'string' ? data['sourceLogId'] : null,
    occurredAt: toDate(data['occurredAt']),
  };
}

function toLog({ id, data }: { id: string; data: DocumentData }): NetworkLog {
  return {
    id,
    deviceId: str(data['deviceId']),
    raw: str(data['raw']),
    daemon: typeof data['daemon'] === 'string' ? data['daemon'] : null,
    parsed: data['parsed'] === true,
    normalized: data['normalized'] === true,
    source: data['source'] === 'state-observer' ? 'state-observer' : 'frr',
    receivedAt: toDate(data['receivedAt']),
  };
}

function toIncident({ id, data }: { id: string; data: DocumentData }): Incident {
  const raw = data['rootCause'];
  const rootCause: RootCause | null =
    typeof raw === 'object' && raw !== null
      ? {
          type: str((raw as DocumentData)['type'], 'unknown') as RootCause['type'],
          devices: strArray((raw as DocumentData)['devices']),
          summary: str((raw as DocumentData)['summary']),
          confidence: str((raw as DocumentData)['confidence'], 'unknown') as RootCause['confidence'],
          evidence: strArray((raw as DocumentData)['evidence']),
          predictedUnreachable: strArray((raw as DocumentData)['predictedUnreachable']),
          observedUnreachable: strArray((raw as DocumentData)['observedUnreachable']),
          predictionMatches: (raw as DocumentData)['predictionMatches'] === true,
        }
      : null;

  return {
    id,
    incidentId: str(data['incidentId'], id),
    status: data['status'] === 'resolved' ? 'resolved' : 'open',
    severity: data['severity'] === 'critical' ? 'critical' : 'warning',
    startedAt: toDate(data['startedAt']),
    resolvedAt: toDate(data['resolvedAt']),
    affectedDevices: strArray(data['affectedDevices']),
    unreachableDevices: strArray(data['unreachableDevices']),
    symptoms: strArray(data['symptoms']),
    probableRootCause: str(data['probableRootCause']),
    rootCauseType: str(data['rootCauseType'], 'unknown'),
    rootCause,
    eventIds: strArray(data['eventIds']),
    eventCount: typeof data['eventCount'] === 'number' ? data['eventCount'] : 0,
  };
}

function toAgentRun({ id, data }: { id: string; data: DocumentData }): AgentRun {
  const status = str(data['status'], 'running');
  const stage = str(data['stage'], 'collecting_evidence');
  const agreement = str(data['agreement']);
  const evidenceRefs = object(data['evidenceRefs']);
  const citedEvidence = object(data['citedEvidence']);
  const usage = object(data['usage']);
  const error = object(data['error']);
  const prompt = object(data['prompt']);
  const labGroundTruth = object(data['labGroundTruth']);
  const evaluation = object(data['evaluation']);
  const truthType = str(labGroundTruth['rootCauseType'], 'unknown');

  return {
    id,
    runId: str(data['runId'], id),
    incidentId: str(data['incidentId']),
    diagnosisVersion: str(data['diagnosisVersion']),
    status: status === 'completed' || status === 'failed' ? status : 'running',
    stage:
      stage === 'analyzing' || stage === 'completed' || stage === 'failed'
        ? stage
        : 'collecting_evidence',
    provider: 'openai',
    model: str(data['model']),
    reasoningEffort: str(data['reasoningEffort']),
    deterministicRootCause: toRootCause(data['deterministicRootCause']),
    labGroundTruth: Object.keys(labGroundTruth).length === 0 ? null : {
      rootCauseType: isAgentRootCause(truthType) ? truthType : 'unknown',
      rootCauseDevices: strArray(labGroundTruth['rootCauseDevices']),
      expectedRemediationTool: remediationTool(labGroundTruth['expectedRemediationTool']),
    },
    evaluation: Object.keys(evaluation).length === 0 ? null : {
      typeMatch: evaluation['typeMatch'] === true,
      devicesMatch: evaluation['devicesMatch'] === true,
      remediationMatch: evaluation['remediationMatch'] === true,
      overallMatch: evaluation['overallMatch'] === true,
    },
    conclusion: toAgentConclusion(data['conclusion']),
    agreement: agreement === 'agree' || agreement === 'disagree' ? agreement : null,
    evidenceEventIds: strArray(evidenceRefs['eventIds']),
    evidenceLogIds: strArray(evidenceRefs['logIds']),
    citedEventIds: strArray(citedEvidence['eventIds']),
    citedLogIds: strArray(citedEvidence['logIds']),
    promptVersion: str(data['promptVersion']),
    prompt: Object.keys(prompt).length === 0 ? null : {
      developer: str(prompt['developer']),
      input: str(prompt['input']),
      version: str(prompt['version']),
    },
    inputTokens: count(usage['inputTokens']),
    outputTokens: count(usage['outputTokens']),
    reasoningTokens: count(usage['reasoningTokens']),
    totalTokens: count(usage['totalTokens']),
    latencyMs: typeof data['latencyMs'] === 'number' ? data['latencyMs'] : null,
    estimatedCostUsd:
      typeof data['estimatedCostUsd'] === 'number' ? data['estimatedCostUsd'] : null,
    error: typeof error['message'] === 'string' ? error['message'] : null,
    startedAt: toDate(data['startedAt']),
    completedAt: toDate(data['completedAt']),
  };
}

function toLabAction({ id, data }: { id: string; data: DocumentData }): LabAction {
  const scenario = str(data['scenario']);
  const status = str(data['status'], 'running');
  return {
    id,
    actionId: str(data['actionId'], id),
    scenario: isLabScenario(scenario) ? scenario : 'configuration-drift',
    label: str(data['label'], scenario),
    status: status === 'completed' || status === 'failed' ? status : 'running',
    output: strArray(data['output']),
    exitCode: typeof data['exitCode'] === 'number' ? data['exitCode'] : null,
    error: typeof data['error'] === 'string' ? data['error'] : null,
    requestedAt: toDate(data['requestedAt']),
    completedAt: toDate(data['completedAt']),
  };
}

function toRootCause(value: unknown): RootCause | null {
  const raw = object(value);
  if (Object.keys(raw).length === 0) return null;
  return {
    type: str(raw['type'], 'unknown') as RootCause['type'],
    devices: strArray(raw['devices']),
    summary: str(raw['summary']),
    confidence: str(raw['confidence'], 'unknown') as RootCause['confidence'],
    evidence: strArray(raw['evidence']),
    predictedUnreachable: strArray(raw['predictedUnreachable']),
    observedUnreachable: strArray(raw['observedUnreachable']),
    predictionMatches: raw['predictionMatches'] === true,
  };
}

function toAgentConclusion(value: unknown): AgentConclusion | null {
  const raw = object(value);
  if (Object.keys(raw).length === 0) return null;
  const type = str(raw['rootCauseType'], 'unknown');
  const confidence = str(raw['confidence'], 'low');
  const proposal = object(raw['remediationProposal']);
  return {
    rootCauseType: isAgentRootCause(type) ? type : 'unknown',
    rootCauseDevices: strArray(raw['rootCauseDevices']),
    summary: str(raw['summary']),
    confidence: confidence === 'high' || confidence === 'medium' ? confidence : 'low',
    reasoning: strArray(raw['reasoning']),
    citedEventIds: strArray(raw['citedEventIds']),
    citedLogIds: strArray(raw['citedLogIds']),
    remediationProposal: {
      tool: remediationTool(proposal['tool']),
      rationale: str(proposal['rationale']),
      citedEvidenceIds: strArray(proposal['citedEvidenceIds']),
    },
  };
}

function isLabScenario(value: string): value is LabAction['scenario'] {
  return value === 'configuration-drift' ||
    value === 'routing-session-failure' ||
    value === 'interface-disabled' ||
    value === 'routing-service-crash' ||
    value === 'resource-exhaustion' ||
    value === 'restore';
}

function isAgentRootCause(value: string): value is AgentConclusion['rootCauseType'] {
  return value === 'configuration_drift' ||
    value === 'routing_session_failure' ||
    value === 'interface_misconfiguration' ||
    value === 'routing_service_failure' ||
    value === 'resource_exhaustion' ||
    value === 'unknown';
}

function remediationTool(value: unknown): AgentConclusion['remediationProposal']['tool'] {
  const tool = str(value, 'escalate_no_safe_action');
  return tool === 'restore_ospf_cost' || tool === 'restore_ospf_adjacency' ||
    tool === 'enable_interface' || tool === 'restart_routing_service' ||
    tool === 'restore_resource_profile'
    ? tool
    : 'escalate_no_safe_action';
}

function object(value: unknown): DocumentData {
  return typeof value === 'object' && value !== null ? value as DocumentData : {};
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
