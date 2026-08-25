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
  Device,
  DeviceState,
  HealthCheck,
  Incident,
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
      query(collection(store, 'networkLogs'), orderBy('receivedAt', 'desc'), limit(300)),
      (docs) => this.logs.set(docs.map(toLog)),
    );
  }

  /** The raw log line behind an event, when it came from one. */
  logFor(sourceLogId: string | null): NetworkLog | undefined {
    if (sourceLogId === null) return undefined;
    return this.logs().find((log) => log.id === sourceLogId);
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
