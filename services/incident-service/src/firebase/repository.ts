import { FieldValue, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';
import type { Incident, ObservedEvent } from '../models/types.js';
import type { Logger } from '../logger.js';

export const COLLECTIONS = {
  networkEvents: 'networkEvents',
  incidents: 'incidents',
} as const;

/** All Firestore access for the Incident Service. */
export class IncidentRepository {
  constructor(
    private readonly db: Firestore,
    private readonly logger: Logger,
  ) {}

  /**
   * Watch networkEvents/ in occurrence order.
   *
   * `since` bounds the stream so a restart does not re-correlate the whole of
   * history into duplicate incidents. onSnapshot delivers an initial batch for
   * everything already matching, then live updates; only added documents are
   * passed on, since events are append-only.
   */
  watchEvents(since: Date, onEvents: (events: ObservedEvent[]) => void): () => void {
    const query: Query = this.db
      .collection(COLLECTIONS.networkEvents)
      .where('occurredAt', '>=', Timestamp.fromDate(since))
      .orderBy('occurredAt');

    return query.onSnapshot(
      (snapshot) => {
        const added = snapshot
          .docChanges()
          .filter((change) => change.type === 'added')
          .map((change) => toObservedEvent(change.doc.id, change.doc.data()))
          .filter((event): event is ObservedEvent => event !== null);

        if (added.length > 0) onEvents(added);
      },
      (error) => {
        // A broken listener must be loud: silently correlating nothing looks
        // exactly like a healthy network.
        this.logger.error(`networkEvents listener failed: ${error.message}`);
      },
    );
  }

  /** Highest existing incident number, so ids continue across a restart. */
  async highestIncidentNumber(): Promise<number> {
    const snapshot = await this.db.collection(COLLECTIONS.incidents).get();

    let highest = 0;
    for (const doc of snapshot.docs) {
      const match = /^INC-(\d+)$/.exec(doc.id);
      if (match === null) continue;
      const value = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(value)) highest = Math.max(highest, value);
    }
    return highest;
  }

  /**
   * Write incidents. The document id is the incidentId, so an incident is
   * updated in place as it develops rather than appended to - the UI and the
   * Increment 4 agent both want the current state of INC-001, not a history of
   * partial guesses about it.
   */
  async saveIncidents(incidents: Incident[]): Promise<number> {
    if (incidents.length === 0) return 0;

    const batch = this.db.batch();

    for (const incident of incidents) {
      const ref = this.db.collection(COLLECTIONS.incidents).doc(incident.incidentId);
      batch.set(
        ref,
        {
          incidentId: incident.incidentId,
          status: incident.status,
          severity: incident.severity,
          startedAt: Timestamp.fromDate(incident.startedAt),
          lastEventAt: Timestamp.fromDate(incident.lastEventAt),
          resolvedAt:
            incident.resolvedAt === null ? null : Timestamp.fromDate(incident.resolvedAt),
          affectedDevices: incident.affectedDevices,
          unreachableDevices: incident.unreachableDevices,
          symptoms: incident.symptoms,
          rootCauseType: incident.rootCause.type,
          probableRootCause: incident.rootCause.summary,
          rootCause: incident.rootCause,
          eventIds: incident.eventIds,
          eventCount: incident.eventCount,
          investigationReady: incident.investigationReady,
          settledAt:
            incident.settledAt === null ? null : Timestamp.fromDate(incident.settledAt),
          investigationRevision: incident.investigationRevision,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    await batch.commit();
    return incidents.length;
  }
}

/** Map a networkEvents document into the shape the correlator consumes. */
export function toObservedEvent(
  id: string,
  data: FirebaseFirestore.DocumentData,
): ObservedEvent | null {
  const occurredAt = data['occurredAt'];
  if (!(occurredAt instanceof Timestamp)) return null;

  const deviceId = data['deviceId'];
  const eventType = data['eventType'];
  if (typeof deviceId !== 'string' || typeof eventType !== 'string') return null;

  const source = data['source'];
  const attributes = data['attributes'];
  const sourceLogId = data['sourceLogId'];
  const severity = data['severity'];

  return {
    id,
    deviceId,
    eventType,
    severity: typeof severity === 'string' ? severity : 'info',
    source: source === 'layer-zero' ? 'layer-zero' : 'health-service',
    sourceLogId: typeof sourceLogId === 'string' ? sourceLogId : null,
    attributes:
      typeof attributes === 'object' && attributes !== null
        ? (attributes as Record<string, unknown>)
        : {},
    occurredAt: occurredAt.toDate(),
  };
}
