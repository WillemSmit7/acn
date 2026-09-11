import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
} from 'firebase-admin/firestore';
import type { Logger } from '../logger.js';
import type {
  AgentRepositoryPort,
  EvidenceBundle,
  EvidenceEvent,
  EvidenceLog,
  InvestigableIncident,
  LabGroundTruth,
  PromptRecord,
  RootCauseType,
  RunClaim,
  RunCompletion,
} from '../models/types.js';

export const COLLECTIONS = {
  incidents: 'incidents',
  networkEvents: 'networkEvents',
  networkLogs: 'networkLogs',
  agentRuns: 'agentRuns',
  labEvaluations: 'labEvaluations',
  labEvaluationState: 'labEvaluationState',
} as const;

export class AgentRepository implements AgentRepositoryPort {
  constructor(
    private readonly db: Firestore,
    private readonly logger: Logger,
  ) {}

  watchIncidents(onIncidents: (incidents: InvestigableIncident[]) => void): () => void {
    return this.db.collection(COLLECTIONS.incidents).onSnapshot(
      (snapshot) => {
        const incidents = snapshot.docChanges()
          .filter((change) => change.type === 'added' || change.type === 'modified')
          .map((change) => toInvestigableIncident(change.doc.id, change.doc.data()))
          .filter((incident): incident is InvestigableIncident => incident !== null);
        if (incidents.length > 0) onIncidents(incidents);
      },
      (error) => this.logger.error(`incidents listener failed: ${error.message}`),
    );
  }

  async claimRun(claim: RunClaim): Promise<boolean> {
    const ref = this.db.collection(COLLECTIONS.agentRuns).doc(claim.runId);
    const currentRef = this.db.collection(COLLECTIONS.labEvaluationState).doc('current');
    return this.db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) return false;
      const current = await transaction.get(currentRef);
      const currentData = current.data();
      const candidateId = current.exists && currentData?.['status'] === 'pending' &&
        typeof currentData['evaluationId'] === 'string'
        ? currentData['evaluationId']
        : null;
      const evaluationRef = candidateId === null
        ? null
        : this.db.collection(COLLECTIONS.labEvaluations).doc(candidateId);
      const evaluation = evaluationRef === null ? null : await transaction.get(evaluationRef);
      const injectionRequestedAt = evaluation?.data()?.['injectionRequestedAt'];
      const incidentStartedAt = claim.incident.startedAt === null
        ? Number.NaN
        : Date.parse(claim.incident.startedAt);
      const evaluationId = evaluation?.data()?.['status'] === 'pending' &&
        injectionRequestedAt instanceof Timestamp && Number.isFinite(incidentStartedAt) &&
        incidentStartedAt >= injectionRequestedAt.toMillis()
        ? candidateId
        : null;
      transaction.create(ref, {
        runId: claim.runId,
        incidentId: claim.incident.incidentId,
        diagnosisVersion: claim.diagnosisVersion,
        incidentStatus: claim.incident.status,
        labEvaluationId: evaluationId,
        status: 'running',
        stage: 'collecting_evidence',
        provider: 'openai',
        model: claim.model,
        reasoningEffort: claim.reasoningEffort,
        promptVersion: claim.promptVersion,
        evidenceRefs: { eventIds: [], logIds: [] },
        citedEvidence: { eventIds: [], logIds: [] },
        startedAt: FieldValue.serverTimestamp(),
        completedAt: null,
        latencyMs: null,
        estimatedCostUsd: null,
        error: null,
      });
      if (evaluationId !== null) {
        transaction.update(evaluationRef!, {
          status: 'claimed',
          claimedAt: FieldValue.serverTimestamp(),
          claimedByIncidentId: claim.incident.incidentId,
          claimedByRunId: claim.runId,
        });
        transaction.update(currentRef, {
          status: 'claimed',
          claimedByIncidentId: claim.incident.incidentId,
          claimedByRunId: claim.runId,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return true;
    });
  }

  async loadEvidence(eventIds: string[]): Promise<EvidenceBundle> {
    if (eventIds.length === 0) throw new Error('Incident has no eventIds');
    const eventRefs = eventIds.map((id) => this.db.collection(COLLECTIONS.networkEvents).doc(id));
    const eventDocs = await this.db.getAll(...eventRefs);
    const byId = new Map<string, EvidenceEvent>();
    for (const doc of eventDocs) {
      if (!doc.exists) throw new Error(`Referenced networkEvents/${doc.id} does not exist`);
      byId.set(doc.id, toEvidenceEvent(doc.id, doc.data() ?? {}));
    }
    const events = eventIds.map((id) => {
      const event = byId.get(id);
      if (event === undefined) throw new Error(`Could not load networkEvents/${id}`);
      return event;
    });

    const logIds = [...new Set(events.flatMap((event) =>
      event.sourceLogId === null ? [] : [event.sourceLogId],
    ))];
    if (logIds.length === 0) return { events, logs: [] };

    const logRefs = logIds.map((id) => this.db.collection(COLLECTIONS.networkLogs).doc(id));
    const logDocs = await this.db.getAll(...logRefs);
    const logs = logDocs.map((doc) => {
      if (!doc.exists) throw new Error(`Referenced networkLogs/${doc.id} does not exist`);
      return toEvidenceLog(doc.id, doc.data() ?? {});
    });
    return { events, logs };
  }

  async loadGroundTruth(runId: string): Promise<LabGroundTruth | null> {
    const run = await this.db.collection(COLLECTIONS.agentRuns).doc(runId).get();
    const evaluationId = run.exists && typeof run.data()?.['labEvaluationId'] === 'string'
      ? run.data()?.['labEvaluationId'] as string
      : null;
    if (evaluationId === null) return null;

    const evaluation = await this.db.collection(COLLECTIONS.labEvaluations).doc(evaluationId).get();
    const expected = evaluation.data()?.['expected'];
    if (!isObject(expected) || !isRootCauseType(expected['rootCauseType'])) return null;
    return {
      rootCauseType: expected['rootCauseType'],
      rootCauseDevices: stringArray(expected['rootCauseDevices']),
    };
  }

  async markAnalyzing(runId: string, evidence: EvidenceBundle, prompt: PromptRecord): Promise<void> {
    await this.db.collection(COLLECTIONS.agentRuns).doc(runId).update({
      stage: 'analyzing',
      evidenceRefs: {
        eventIds: evidence.events.map((event) => event.id),
        logIds: evidence.logs.map((log) => log.id),
      },
      prompt,
    });
  }

  async completeRun(runId: string, completion: RunCompletion): Promise<void> {
    await this.db.collection(COLLECTIONS.agentRuns).doc(runId).update({
      status: 'completed',
      stage: 'completed',
      conclusion: completion.conclusion,
      labGroundTruth: completion.groundTruth,
      evaluation: completion.evaluation,
      agreement: completion.evaluation === null
        ? null
        : completion.evaluation.overallMatch ? 'agree' : 'disagree',
      citedEvidence: {
        eventIds: completion.conclusion.citedEventIds,
        logIds: completion.conclusion.citedLogIds,
      },
      responseId: completion.responseId,
      responseModel: completion.responseModel,
      usage: completion.usage,
      latencyMs: completion.latencyMs,
      estimatedCostUsd: completion.estimatedCostUsd,
      pricing: {
        currency: 'USD',
        perMillionTokens: {
          input: 0.20,
          cachedInput: 0.02,
          cacheWrite: 0.25,
          output: 1.20,
        },
        asOf: '2026-08-26',
      },
      completedAt: FieldValue.serverTimestamp(),
      error: null,
    });
  }

  async failRun(runId: string, error: unknown, latencyMs: number): Promise<void> {
    await this.db.collection(COLLECTIONS.agentRuns).doc(runId).update({
      status: 'failed',
      stage: 'failed',
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
      latencyMs,
      completedAt: FieldValue.serverTimestamp(),
    });
  }
}

export function toInvestigableIncident(id: string, data: DocumentData): InvestigableIncident | null {
  const eventIds = stringArray(data['eventIds']);
  if (eventIds.length === 0) return null;
  return {
    incidentId: typeof data['incidentId'] === 'string' ? data['incidentId'] : id,
    status: data['status'] === 'resolved' ? 'resolved' : 'open',
    severity: data['severity'] === 'critical' ? 'critical' : 'warning',
    startedAt: timestamp(data['startedAt']),
    symptoms: stringArray(data['symptoms']),
    affectedDevices: stringArray(data['affectedDevices']),
    eventIds,
  };
}

function toEvidenceEvent(id: string, data: DocumentData): EvidenceEvent {
  return {
    id,
    deviceId: text(data['deviceId']),
    eventType: text(data['eventType']),
    severity: text(data['severity'], 'info'),
    source: data['source'] === 'layer-zero' ? 'layer-zero' : 'health-service',
    sourceLogId: typeof data['sourceLogId'] === 'string' ? data['sourceLogId'] : null,
    attributes: isObject(data['attributes']) ? data['attributes'] : {},
    occurredAt: timestamp(data['occurredAt']),
  };
}

function toEvidenceLog(id: string, data: DocumentData): EvidenceLog {
  return {
    id,
    deviceId: text(data['deviceId']),
    raw: text(data['raw']),
    daemon: typeof data['daemon'] === 'string' ? data['daemon'] : null,
    loggedAt: timestamp(data['loggedAt']),
  };
}

function timestamp(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRootCauseType(value: unknown): value is RootCauseType {
  return value === 'configuration_drift' ||
    value === 'routing_session_failure' ||
    value === 'interface_misconfiguration' ||
    value === 'routing_service_failure' ||
    value === 'resource_exhaustion' ||
    value === 'unknown';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
