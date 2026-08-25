/**
 * ACN Increment 1 data model.
 *
 * These types mirror the Firestore collections described in
 * docs/data-model.md. Later increments add networkLogs, incidents,
 * agentRuns, agentActions and networkChanges.
 */

/** A managed network device the Health Service observes. */
export interface Device {
  /** Stable short identifier, e.g. "r2". Used as the Firestore document id. */
  id: string;
  name: string;
  type: DeviceType;
  /**
   * Address used for management access (docker exec / vtysh / SSH later).
   * Always reachable in the lab, so it is NOT what reachability is judged on.
   */
  managementAddress: string;
  /**
   * Address the reachability check targets. For routers this is the loopback,
   * which is only reachable through the data plane - so a broken link actually
   * shows up as a failure.
   */
  checkAddress: string;
  enabled: boolean;
}

export type DeviceType = 'router' | 'host';

/** Health check outcome. Unknown is used before the first check completes. */
export type HealthStatus = 'healthy' | 'down' | 'unknown';

export type CheckType = 'icmp';

/** One reachability measurement. Persisted to healthChecks/. */
export interface HealthCheckResult {
  deviceId: string;
  checkType: CheckType;
  status: Exclude<HealthStatus, 'unknown'>;
  /** Round-trip time in milliseconds, or null when the device did not reply. */
  latencyMs: number | null;
  /** Target address that was probed. */
  target: string;
  /** Short human-readable reason, present on failure. */
  error?: string;
}

/**
 * Normalized network event. Increment 1 emits only the two device-level
 * transitions below; Layer 0 (Increment 2) adds log-derived event types.
 */
export type NetworkEventType = 'device_unreachable' | 'device_recovered';

export type Severity = 'critical' | 'warning' | 'info';

export interface NetworkEvent {
  deviceId: string;
  eventType: NetworkEventType;
  severity: Severity;
  /** Event-type specific detail. Kept open so Layer 0 can extend it. */
  attributes: Record<string, unknown>;
  /** Which component produced the event. */
  source: 'health-service';
}

/**
 * Increment 2 note: networkEvents/ is now written by two producers. Layer 0
 * adds log-derived types (interface_down, ospf_neighbor_down, ...) carrying a
 * sourceLogId back-reference. The Health Service writes sourceLogId as null,
 * since an ICMP probe has no originating log line. `source` is what tells the
 * two apart - see services/layer-zero/src/models/types.ts.
 */

/** Status transition detected between two consecutive check rounds. */
export interface StateTransition {
  deviceId: string;
  from: HealthStatus;
  to: HealthStatus;
}
