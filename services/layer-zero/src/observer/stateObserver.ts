import type { Logger } from '../logger.js';
import type { LogEventType, Severity, StateObservation } from '../models/types.js';
import type { RouterStateSnapshot, StateProbePort } from './dockerStateProbe.js';

interface ConditionDefinition {
  key: string;
  deviceId: 'r2' | 'r3';
  active: (snapshot: RouterStateSnapshot) => boolean;
  faultType: LogEventType;
  recoveryType: LogEventType;
  severity: Severity;
  attributes: (snapshot: RouterStateSnapshot, active: boolean) => Record<string, unknown>;
}

const CONDITIONS: ConditionDefinition[] = [
  {
    key: 'r2:ospf-cost',
    deviceId: 'r2',
    active: (snapshot) => snapshot.facts['ospfCost'] !== 10,
    faultType: 'configuration_drift',
    recoveryType: 'configuration_restored',
    severity: 'warning',
    attributes: (snapshot, active) => ({
      component: 'ospf', interface: 'eth2', setting: 'cost', expected: '10',
      observed: String(active ? snapshot.facts['ospfCost'] : 10),
    }),
  },
  {
    key: 'r2:ospf-passive',
    deviceId: 'r2',
    active: (snapshot) => snapshot.facts['passiveEth2'] === true,
    faultType: 'routing_session_down',
    recoveryType: 'routing_session_up',
    severity: 'warning',
    attributes: (_snapshot, active) => ({
      protocol: 'ospf', interface: 'eth2', peer: '10.255.0.3',
      cause: 'passive_interface', interfaceState: 'up', configuredPassive: active,
    }),
  },
  {
    key: 'r2:eth2-admin',
    deviceId: 'r2',
    active: (snapshot) => snapshot.facts['eth2AdminDown'] === true,
    faultType: 'interface_admin_down',
    recoveryType: 'interface_admin_up',
    severity: 'warning',
    attributes: (_snapshot, active) => ({
      interface: 'eth2', peer: 'r3', adminState: active ? 'down' : 'up', expectedState: 'up',
    }),
  },
  {
    key: 'r3:ospfd-process',
    deviceId: 'r3',
    active: (snapshot) => snapshot.facts['ospfdProcessState'] === 'missing',
    faultType: 'routing_service_down',
    recoveryType: 'routing_service_up',
    severity: 'critical',
    attributes: (_snapshot, active) => ({
      service: 'ospfd', processState: active ? 'stopped' : 'running', containerState: 'running',
    }),
  },
  {
    key: 'r3:cpu-pressure',
    deviceId: 'r3',
    active: (snapshot) =>
      typeof snapshot.facts['cpuQuotaPercent'] === 'number' &&
      snapshot.facts['cpuQuotaPercent'] <= 15 &&
      snapshot.facts['ospfdProcessState'] === 'stopped',
    faultType: 'resource_exhaustion',
    recoveryType: 'resource_recovered',
    severity: 'critical',
    attributes: (snapshot, active) => ({
      resource: 'cpu', quota: `${String(snapshot.facts['cpuQuotaPercent'])}pct`,
      impactedService: 'ospfd', serviceState: active ? 'starved' : 'running',
    }),
  },
];

/**
 * Periodically inspects live router state and emits only fault/recovery edges.
 * Healthy first observations seed the baseline; a fault present at startup is
 * emitted immediately because the intended state is known independently.
 */
export class AutonomousStateObserver {
  private readonly active = new Map<string, boolean>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly probe: StateProbePort,
    private readonly intervalMs: number,
    private readonly emit: (observation: StateObservation) => void,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.logger.info(`Autonomous state observer polling every ${this.intervalMs}ms`);
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const snapshots = await this.probe.inspect();
      if (this.stopped) return;
      for (const snapshot of snapshots) this.observeSnapshot(snapshot);
    } catch (error) {
      this.logger.warn(`State observation failed: ${describe(error)}`);
    } finally {
      this.polling = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private observeSnapshot(snapshot: RouterStateSnapshot): void {
    for (const condition of CONDITIONS) {
      if (condition.deviceId !== snapshot.deviceId) continue;
      const nowActive = condition.active(snapshot);
      const wasActive = this.active.get(condition.key) ?? false;
      this.active.set(condition.key, nowActive);
      if (nowActive === wasActive) continue;

      this.emit({
        deviceId: condition.deviceId,
        eventType: nowActive ? condition.faultType : condition.recoveryType,
        severity: nowActive ? condition.severity : 'info',
        attributes: condition.attributes(snapshot, nowActive),
        raw: snapshot.raw,
        observedAt: snapshot.observedAt,
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
