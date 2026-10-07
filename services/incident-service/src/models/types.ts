/**
 * ACN Increment 3 data model.
 *
 * The Incident Service consumes networkEvents/ (written by the Health Service
 * and by Layer 0) and produces incidents/. See docs/incident-model.md.
 */

/** Event types that indicate something broke. */
export const FAULT_EVENTS = [
  'device_unreachable',
  'interface_down',
  'ospf_neighbor_down',
  'configuration_drift',
  'routing_session_down',
  'interface_admin_down',
  'routing_service_down',
  'resource_exhaustion',
] as const;

/** Event types that indicate something came back. */
export const RECOVERY_EVENTS = [
  'device_recovered',
  'interface_up',
  'ospf_neighbor_up',
  'configuration_restored',
  'routing_session_up',
  'interface_admin_up',
  'routing_service_up',
  'resource_recovered',
] as const;

export type FaultEventType = (typeof FAULT_EVENTS)[number];
export type RecoveryEventType = (typeof RECOVERY_EVENTS)[number];

export type EventSource = 'health-service' | 'layer-zero';

/** One networkEvents/ document, as read by the correlator. */
export interface ObservedEvent {
  /** networkEvents document id. */
  id: string;
  deviceId: string;
  eventType: string;
  severity: string;
  source: EventSource;
  /** networkLogs id when the event came from a log line, else null. */
  sourceLogId: string | null;
  attributes: Record<string, unknown>;
  occurredAt: Date;
}

export type RootCauseType =
  | 'configuration_drift'
  | 'routing_session_failure'
  | 'interface_misconfiguration'
  | 'routing_service_failure'
  | 'resource_exhaustion'
  | 'link_failure'
  | 'device_failure'
  | 'unknown'
  | 'analyzing';

/**
 * How much the evidence supports the conclusion.
 *
 * `confirmed` means both ends of a link independently reported losing each
 * other. `probable` means one end reported and the silent peer is itself
 * unreachable - consistent with that peer having failed, but the peer cannot
 * corroborate because it is gone.
 */
export type Confidence = 'confirmed' | 'probable' | 'unknown';

export interface RootCause {
  type: RootCauseType;
  /** Devices implicated - two for a link failure, one for a device failure. */
  devices: string[];
  /** Human-readable summary, e.g. "R2 <-> R3 link failure". */
  summary: string;
  confidence: Confidence;
  /** Why the correlator concluded this, in plain language. */
  evidence: string[];
  /** Devices this root cause implies should be unreachable. */
  predictedUnreachable: string[];
  /** Devices actually observed unreachable. */
  observedUnreachable: string[];
  /** Whether the prediction matched observation - a self-check on the inference. */
  predictionMatches: boolean;
}

export type IncidentStatus = 'open' | 'resolved';

export interface Incident {
  /** Sequential, human-facing: INC-001. Also the Firestore document id. */
  incidentId: string;
  status: IncidentStatus;
  severity: 'critical' | 'warning';
  startedAt: Date;
  /** Timestamp of the most recent event attached to this incident. */
  lastEventAt: Date;
  resolvedAt: Date | null;
  /** Every device that appears in any attached event. */
  affectedDevices: string[];
  /** Devices currently unreachable and not yet recovered. */
  unreachableDevices: string[];
  /** Short human-readable symptom lines. */
  symptoms: string[];
  rootCause: RootCause;
  /** networkEvents ids attached to this incident, in order. */
  eventIds: string[];
  eventCount: number;
  /** True only after the latest fault evidence has been quiet for the settle window. */
  investigationReady: boolean;
  /** When the evidence generation currently offered to the agent became ready. */
  settledAt: Date | null;
  /** Monotonic identity for materially different, settled fault evidence. */
  investigationRevision: number;
}

export function isFaultEvent(eventType: string): boolean {
  return (FAULT_EVENTS as readonly string[]).includes(eventType);
}

export function isRecoveryEvent(eventType: string): boolean {
  return (RECOVERY_EVENTS as readonly string[]).includes(eventType);
}

/** The fault an event undoes, so recovery can be matched to it. */
export function faultForRecovery(eventType: string): FaultEventType | null {
  switch (eventType) {
    case 'device_recovered':
      return 'device_unreachable';
    case 'interface_up':
      return 'interface_down';
    case 'ospf_neighbor_up':
      return 'ospf_neighbor_down';
    case 'configuration_restored':
      return 'configuration_drift';
    case 'routing_session_up':
      return 'routing_session_down';
    case 'interface_admin_up':
      return 'interface_admin_down';
    case 'routing_service_up':
      return 'routing_service_down';
    case 'resource_recovered':
      return 'resource_exhaustion';
    default:
      return null;
  }
}
