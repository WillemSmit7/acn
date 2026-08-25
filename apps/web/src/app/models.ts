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
  receivedAt: Date | null;
}

export interface RootCause {
  type: 'link_failure' | 'device_failure' | 'unknown' | 'analyzing';
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

/** Latest known state of a device, derived from its most recent health check. */
export interface DeviceState {
  device: Device;
  status: 'healthy' | 'down' | 'unknown';
  latencyMs: number | null;
  checkedAt: Date | null;
}
