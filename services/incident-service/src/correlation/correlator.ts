import type { Incident, ObservedEvent } from '../models/types.js';
import { faultForRecovery, isFaultEvent, isRecoveryEvent } from '../models/types.js';
import { areAdjacent, deviceForRouterId } from '../config/topology.js';
import { inferRootCause } from './rootCause.js';

export interface CorrelatorOptions {
  /**
   * How long an incident stays open to absorb related events. A failure and its
   * consequences arrive within a second or two in this lab; the window is
   * generous because merging two views of one fault is far less harmful than
   * splitting one fault into two incidents.
   */
  correlationWindowMs: number;
  /**
   * Quiet period before a root cause is treated as settled. Without it the
   * first event of a link failure would be judged before the far end has had
   * any chance to corroborate, and every link failure would briefly be
   * misreported as a device failure.
   */
  settleMs: number;
}

/** An open incident plus the bookkeeping needed to decide when it closes. */
interface OpenIncident {
  incident: Incident;
  /** Devices with an outstanding device_unreachable. */
  unreachable: Set<string>;
  /**
   * Link/interface faults not yet matched by a recovery. Used to decide whether
   * a recovery event belongs to this incident - NOT to decide resolution, which
   * follows reachability instead. See tick().
   */
  outstandingFaults: Set<string>;
  /**
   * Faults whose continued existence cannot be inferred from reachability.
   * They remain open until their explicit recovery observation arrives.
   */
  persistentFaults: Set<string>;
  /** True once the root cause has been computed after the settle window. */
  settled: boolean;
  /**
   * True once a definite conclusion has been reached. The diagnosis describes
   * what broke, and recovery is not evidence about that: bringing a link back
   * makes both ends emit interface events again, which would otherwise turn a
   * correctly diagnosed device failure into a "confirmed link failure" the
   * moment the dead router came back and started logging.
   */
  rootCauseFrozen: boolean;
  /**
   * Timestamp of the last FAULT event. The absorption window is measured from
   * here rather than from the last event of any kind, so an incident in a long
   * recovery does not keep swallowing unrelated faults that follow it.
   */
  lastFaultAt: Date;
  dirty: boolean;
}

/**
 * Groups related networkEvents into incidents.
 *
 * Deliberately in-memory and single-instance. Persisting correlation state
 * across restarts is a real concern but not this increment's: on restart the
 * service resumes from the current moment, exactly like the Health Service's
 * baseline seeding and Layer 0's tail.
 */
export class Correlator {
  private readonly open = new Map<string, OpenIncident>();
  private readonly closed: Incident[] = [];
  private sequence = 0;

  constructor(private readonly options: CorrelatorOptions) {}

  /** Seed the incident counter so ids continue across a restart. */
  seedSequence(highest: number): void {
    this.sequence = Math.max(this.sequence, highest);
  }

  /**
   * Feed one event in. Returns the incident it was attached to, or null when
   * the event was not incident-worthy (a recovery with nothing to recover).
   */
  observe(event: ObservedEvent): Incident | null {
    if (isRecoveryEvent(event.eventType)) return this.applyRecovery(event);
    if (!isFaultEvent(event.eventType)) return null;

    const target = this.findIncidentFor(event) ?? this.openIncident(event);
    this.attach(target, event);
    return target.incident;
  }

  /**
   * Which open incident does this event belong to?
   *
   * An event joins an incident when it concerns a device already involved, or a
   * device directly adjacent to one, and arrives within the correlation window.
   * Topology is what keeps unrelated simultaneous faults apart - without it,
   * anything happening at the same time would collapse into one incident.
   */
  private findIncidentFor(event: ObservedEvent): OpenIncident | null {
    for (const candidate of this.open.values()) {
      if (candidate.incident.status !== 'open') continue;

      const age = event.occurredAt.getTime() - candidate.lastFaultAt.getTime();
      if (age > this.options.correlationWindowMs) continue;

      if (this.relatesTo(candidate, event)) return candidate;
    }
    return null;
  }

  private relatesTo(candidate: OpenIncident, event: ObservedEvent): boolean {
    const involved = candidate.incident.affectedDevices;
    if (involved.includes(event.deviceId)) return true;
    if (involved.some((device) => areAdjacent(device, event.deviceId))) return true;

    // An adjacency event names its peer explicitly; if that peer is already
    // implicated, this is the same fault seen from the other side.
    const neighborId = event.attributes['neighborId'];
    if (typeof neighborId === 'string') {
      const peer = deviceForRouterId(neighborId);
      if (peer !== null && involved.includes(peer)) return true;
    }

    return false;
  }

  private openIncident(event: ObservedEvent): OpenIncident {
    this.sequence += 1;
    const incidentId = `INC-${String(this.sequence).padStart(3, '0')}`;

    const incident: Incident = {
      incidentId,
      status: 'open',
      severity: 'warning',
      startedAt: event.occurredAt,
      lastEventAt: event.occurredAt,
      resolvedAt: null,
      affectedDevices: [],
      unreachableDevices: [],
      symptoms: [],
      rootCause: {
        type: 'analyzing',
        devices: [],
        summary: 'Correlating events',
        confidence: 'unknown',
        evidence: [],
        predictedUnreachable: [],
        observedUnreachable: [],
        predictionMatches: false,
      },
      eventIds: [],
      eventCount: 0,
      investigationReady: false,
      settledAt: null,
      investigationRevision: 0,
    };

    const entry: OpenIncident = {
      incident,
      unreachable: new Set(),
      outstandingFaults: new Set(),
      persistentFaults: new Set(),
      settled: false,
      rootCauseFrozen: false,
      lastFaultAt: event.occurredAt,
      dirty: true,
    };
    this.open.set(incidentId, entry);
    return entry;
  }

  private attach(entry: OpenIncident, event: ObservedEvent): void {
    const { incident } = entry;

    incident.eventIds.push(event.id);
    incident.eventCount = incident.eventIds.length;
    if (event.occurredAt > incident.lastEventAt) incident.lastEventAt = event.occurredAt;
    if (event.occurredAt < incident.startedAt) incident.startedAt = event.occurredAt;

    if (!incident.affectedDevices.includes(event.deviceId)) {
      incident.affectedDevices = [...incident.affectedDevices, event.deviceId].sort();
    }
    if (event.severity === 'critical') incident.severity = 'critical';

    if (event.eventType === 'device_unreachable') {
      entry.unreachable.add(event.deviceId);
    }
    entry.outstandingFaults.add(faultKey(event));
    if (isPersistentStateFault(event.eventType)) {
      entry.persistentFaults.add(faultKey(event));
    }
    if (event.occurredAt > entry.lastFaultAt) entry.lastFaultAt = event.occurredAt;

    this.events.set(event.id, event);
    entry.settled = false;
    incident.investigationReady = false;
    incident.settledAt = null;
    entry.dirty = true;
  }

  /** Every event seen, keyed by id, so a root cause can be recomputed. */
  private readonly events = new Map<string, ObservedEvent>();

  private applyRecovery(event: ObservedEvent): Incident | null {
    const fault = faultForRecovery(event.eventType);
    if (fault === null) return null;

    for (const entry of this.open.values()) {
      if (entry.incident.status !== 'open') continue;
      if (!this.relatesTo(entry, event)) continue;

      const key = faultKey({ ...event, eventType: fault });
      if (!entry.outstandingFaults.has(key) && !entry.unreachable.has(event.deviceId)) {
        continue;
      }

      entry.outstandingFaults.delete(key);
      entry.persistentFaults.delete(key);
      if (event.eventType === 'device_recovered') entry.unreachable.delete(event.deviceId);

      entry.incident.eventIds.push(event.id);
      entry.incident.eventCount = entry.incident.eventIds.length;
      if (event.occurredAt > entry.incident.lastEventAt) {
        entry.incident.lastEventAt = event.occurredAt;
      }
      this.events.set(event.id, event);
      entry.dirty = true;

      return entry.incident;
    }

    return null;
  }

  /**
   * Recompute root causes that have settled and close incidents whose faults
   * have all cleared. Returns every incident whose stored form changed.
   */
  tick(now: Date): Incident[] {
    const changed: Incident[] = [];

    for (const entry of this.open.values()) {
      const quietFor = now.getTime() - entry.incident.lastEventAt.getTime();

      // Outstanding unreachability is live state, not something fixed at the
      // moment the root cause was worked out: devices recover one at a time,
      // and an incident that still lists a recovered device is simply wrong.
      const stillUnreachable = [...entry.unreachable].sort();
      if (!sameDevices(entry.incident.unreachableDevices, stillUnreachable)) {
        entry.incident.unreachableDevices = stillUnreachable;
        entry.dirty = true;
      }

      if (!entry.settled && quietFor >= this.options.settleMs) {
        this.settle(entry);
        entry.settled = true;
        entry.incident.investigationReady = true;
        entry.incident.settledAt = now;
        entry.incident.investigationRevision += 1;
        entry.dirty = true;

        const { type } = entry.incident.rootCause;
        if (type !== 'unknown' && type !== 'analyzing') {
          entry.rootCauseFrozen = true;
        }
      }

      // Native link incidents follow observed reachability rather than a tally
      // of interface/adjacency recoveries. Two things make that tally unreliable:
      //   - FRR log timestamps have one-second resolution, so an interface
      //     down/up pair inside the same second can be ordered either way. Seen
      //     "up" first, the trailing "down" re-opens a fault nothing will ever
      //     clear, and the incident hangs open forever.
      //   - Recovery events can simply be missed - the collector reattaches its
      //     tail when the lab is redeployed and the log files are recreated.
      // The Health Service keeps re-checking reachability every round, so it is
      // self-correcting for those faults. Configuration, session, admin-state,
      // service, and resource faults can exist while every device still answers;
      // those remain open until the autonomous observer emits their recovery.
      const quietOfFaults = now.getTime() - entry.lastFaultAt.getTime();
      const cleared =
        entry.unreachable.size === 0 &&
        entry.persistentFaults.size === 0 &&
        quietOfFaults >= this.options.settleMs;
      if (cleared && entry.settled && entry.incident.status === 'open') {
        entry.incident.status = 'resolved';
        entry.incident.resolvedAt = entry.incident.lastEventAt;
        entry.dirty = true;
      }

      if (entry.dirty) {
        changed.push(entry.incident);
        entry.dirty = false;
      }

      if (entry.incident.status === 'resolved') {
        this.closed.push(entry.incident);
        this.open.delete(entry.incident.incidentId);
      }
    }

    return changed;
  }

  private settle(entry: OpenIncident): void {
    const events = entry.incident.eventIds
      .map((id) => this.events.get(id))
      .filter((event): event is ObservedEvent => event !== undefined);

    entry.incident.symptoms = buildSymptoms(events);

    // Only the fault phase is evidence about what broke. Events from after the
    // first recovery describe the network coming back, and folding those in is
    // what would let a restored router retrospectively exonerate itself.
    const faultPhase = eventsBeforeRecovery(events);

    // Root cause is judged on the devices seen unreachable at any point, not
    // only those still down: by the time an incident settles some may already
    // have recovered, and the symptom still happened.
    const everUnreachable = faultPhase
      .filter((event) => event.eventType === 'device_unreachable')
      .map((event) => event.deviceId);

    if (entry.rootCauseFrozen) {
      const observed = [...new Set(everUnreachable)].sort();
      const predicted = entry.incident.rootCause.predictedUnreachable;
      entry.incident.rootCause.observedUnreachable = observed;
      entry.incident.rootCause.predictionMatches = sameDevices(predicted, observed);
      return;
    }

    entry.incident.rootCause = inferRootCause(faultPhase, [...new Set(everUnreachable)]);
  }

  openIncidents(): Incident[] {
    return [...this.open.values()].map((entry) => entry.incident);
  }

  resolvedIncidents(): Incident[] {
    return [...this.closed];
  }
}

/**
 * Identity of a fault, so a later recovery can cancel the right one. Interface
 * and adjacency faults are per-interface/peer; device faults are per-device.
 */
function faultKey(event: Pick<ObservedEvent, 'deviceId' | 'eventType' | 'attributes'>): string {
  const iface = event.attributes['interface'];
  const neighbor = event.attributes['neighborId'];
  const qualifier =
    typeof iface === 'string' ? iface : typeof neighbor === 'string' ? neighbor : '';
  return `${event.deviceId}:${event.eventType}:${qualifier}`;
}

/**
 * Everything up to the first recovery event. Once anything starts coming back,
 * later events belong to the recovery narrative rather than to the diagnosis.
 */
function eventsBeforeRecovery(events: ObservedEvent[]): ObservedEvent[] {
  const chronological = [...events].sort((left, right) =>
    left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
  );
  const firstRecovery = chronological.findIndex((event) => isRecoveryEvent(event.eventType));
  return firstRecovery === -1 ? chronological : chronological.slice(0, firstRecovery);
}

function sameDevices(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((device, index) => device === b[index]);
}

const PERSISTENT_STATE_FAULTS = new Set([
  'configuration_drift',
  'routing_session_down',
  'interface_admin_down',
  'routing_service_down',
  'resource_exhaustion',
]);

function isPersistentStateFault(eventType: string): boolean {
  return PERSISTENT_STATE_FAULTS.has(eventType);
}

function buildSymptoms(events: ObservedEvent[]): string[] {
  const symptoms = new Set<string>();

  for (const event of events) {
    switch (event.eventType) {
      case 'device_unreachable':
        symptoms.add(`${event.deviceId} unreachable`);
        break;
      case 'interface_down': {
        const iface = event.attributes['interface'];
        if (typeof iface === 'string') symptoms.add(`${event.deviceId} ${iface} down`);
        break;
      }
      case 'ospf_neighbor_down': {
        const neighbor = event.attributes['neighborId'];
        if (typeof neighbor === 'string') {
          symptoms.add(`${event.deviceId} lost OSPF neighbour ${neighbor}`);
        }
        break;
      }
      case 'configuration_drift':
        symptoms.add(`${event.deviceId} configuration drift detected`);
        break;
      case 'routing_session_down':
        symptoms.add(`${event.deviceId} routing session down`);
        break;
      case 'interface_admin_down': {
        const iface = event.attributes['interface'];
        symptoms.add(`${event.deviceId} ${typeof iface === 'string' ? iface : 'interface'} administratively down`);
        break;
      }
      case 'routing_service_down': {
        const service = event.attributes['service'];
        symptoms.add(`${event.deviceId} ${typeof service === 'string' ? service : 'routing service'} down`);
        break;
      }
      case 'resource_exhaustion': {
        const resource = event.attributes['resource'];
        symptoms.add(`${event.deviceId} ${typeof resource === 'string' ? resource : 'resource'} exhausted`);
        break;
      }
      default:
        break;
    }
  }

  return [...symptoms].sort();
}
