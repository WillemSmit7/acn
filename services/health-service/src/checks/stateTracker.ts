import type {
  HealthCheckResult,
  HealthStatus,
  NetworkEvent,
  StateTransition,
} from '../models/types.js';

/**
 * Tracks the last known status of each device so that healthy <-> down
 * transitions can be turned into network events.
 *
 * This is the smallest possible form of event generation and the seed of the
 * Layer 0 work in Increment 2. It is intentionally in-memory: on restart the
 * first round establishes a baseline rather than emitting phantom events.
 */
export class StateTracker {
  private readonly lastStatus = new Map<string, HealthStatus>();

  /**
   * Record a check result and return the transition it caused, if any.
   *
   * The first observation of a device seeds the baseline and never produces a
   * transition, so restarting the service does not spam events.
   */
  observe(result: HealthCheckResult): StateTransition | null {
    const previous = this.lastStatus.get(result.deviceId) ?? 'unknown';
    this.lastStatus.set(result.deviceId, result.status);

    if (previous === 'unknown' || previous === result.status) {
      return null;
    }

    return { deviceId: result.deviceId, from: previous, to: result.status };
  }

  /** Record a whole round and return every transition it produced. */
  observeAll(results: HealthCheckResult[]): StateTransition[] {
    const transitions: StateTransition[] = [];
    for (const result of results) {
      const transition = this.observe(result);
      if (transition !== null) transitions.push(transition);
    }
    return transitions;
  }

  statusOf(deviceId: string): HealthStatus {
    return this.lastStatus.get(deviceId) ?? 'unknown';
  }
}

/** Map a status transition onto the normalized network event it represents. */
export function transitionToEvent(transition: StateTransition): NetworkEvent | null {
  if (transition.to === 'down') {
    return {
      deviceId: transition.deviceId,
      eventType: 'device_unreachable',
      severity: 'critical',
      attributes: { previousStatus: transition.from, checkType: 'icmp' },
      source: 'health-service',
    };
  }

  if (transition.to === 'healthy') {
    return {
      deviceId: transition.deviceId,
      eventType: 'device_recovered',
      severity: 'info',
      attributes: { previousStatus: transition.from, checkType: 'icmp' },
      source: 'health-service',
    };
  }

  return null;
}
