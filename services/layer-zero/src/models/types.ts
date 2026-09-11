/**
 * ACN Layer 0 data model.
 *
 * Layer 0 turns raw device log lines into normalized networkEvents. It owns
 * two collections: networkLogs/ (the untouched original text) and the
 * log-derived half of networkEvents/. See docs/data-model.md.
 *
 * The raw line is always stored, even when nothing can be made of it. An
 * event that cannot be traced back to the exact text it came from is not
 * evidence, and Increment 4's agent will be reasoning from this.
 */

/** Where a raw observation came from. */
export type LogSource = 'frr' | 'state-observer';

/** A log line exactly as the device emitted it, before interpretation. */
export interface RawLogLine {
  deviceId: string;
  source: LogSource;
  /** The complete original line, unmodified. */
  raw: string;
}

/**
 * A raw line after structural parsing - the envelope is understood, the
 * meaning is not yet. FRR lines look like:
 *
 *   2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)
 *   2026/08/25 18:45:41 ZEBRA: [NNACN-54BDA][EC 4043309110] Disabling MPLS support
 */
export interface ParsedLogLine {
  /** FRR's own timestamp. Container clocks are UTC - see parseFrrLine. */
  loggedAt: Date;
  /** Emitting daemon: ZEBRA, OSPF, WATCHFRR, MGMTD, STATIC. */
  daemon: string;
  /** FRR's stable per-message identifier, e.g. "SBFM4-2P25V". */
  code: string;
  /** The [EC nnn] error code when present. */
  errorCode: number | null;
  /** Message body, with the timestamp/daemon/code prefixes stripped. */
  message: string;
}

/**
 * Event types Layer 0 produces. The Health Service separately produces
 * device_unreachable / device_recovered from ICMP; both land in
 * networkEvents/ and are told apart by the `source` field.
 */
export type LogEventType =
  | 'interface_down'
  | 'interface_up'
  | 'ospf_neighbor_down'
  | 'ospf_neighbor_up'
  | 'configuration_drift'
  | 'configuration_restored'
  | 'routing_session_down'
  | 'routing_session_up'
  | 'interface_admin_down'
  | 'interface_admin_up'
  | 'routing_service_down'
  | 'routing_service_up'
  | 'resource_exhaustion'
  | 'resource_recovered';

export type Severity = 'critical' | 'warning' | 'info';

/** A normalized event derived from exactly one raw log line. */
export interface NormalizedEvent {
  deviceId: string;
  eventType: LogEventType;
  severity: Severity;
  /** Event-type specific detail extracted from the message. */
  attributes: Record<string, unknown>;
  source: 'layer-zero';
  /**
   * Firestore document id of the networkLogs/ entry this came from, so the
   * original text behind any event is always one lookup away.
   */
  sourceLogId: string;
  /** The device's own timestamp for when this happened. */
  occurredAt: Date;
}

/** One raw line paired with whatever Layer 0 managed to make of it. */
export interface ProcessedLine {
  raw: RawLogLine;
  parsed: ParsedLogLine | null;
  /** Built by the normalization rules; null when no rule matched. */
  event: Omit<NormalizedEvent, 'sourceLogId'> | null;
}

/** A typed state transition produced by the autonomous read-only observer. */
export interface StateObservation {
  deviceId: string;
  eventType: LogEventType;
  severity: Severity;
  attributes: Record<string, unknown>;
  /** Exact output returned by the fixed read-only probe. */
  raw: string;
  observedAt: Date;
}
