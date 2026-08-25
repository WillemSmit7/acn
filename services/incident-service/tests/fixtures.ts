import type { ObservedEvent } from '../src/models/types.js';

/**
 * Event sequences captured from the real lab, not invented.
 *
 * Scenario 01 (R2 eth2 shut) and scenario 02 (R3 container stopped) were each
 * run against the live topology with the Health Service and Layer 0 attached;
 * these are the events they produced. The difference between the two lists is
 * the entire basis of Increment 3's root-cause inference, so it matters that
 * they are observed rather than assumed.
 */

let clock = 0;

/** Events arrive within a second or two of each other in practice. */
function at(offsetSeconds: number): Date {
  return new Date(Date.UTC(2026, 7, 25, 20, 0, 0) + offsetSeconds * 1000);
}

export function resetClock(): void {
  clock = 0;
}

function event(partial: Partial<ObservedEvent> & Pick<ObservedEvent, 'deviceId' | 'eventType'>): ObservedEvent {
  clock += 1;
  return {
    id: `evt-${clock}`,
    severity: 'warning',
    source: 'layer-zero',
    sourceLogId: `log-${clock}`,
    attributes: {},
    occurredAt: at(0),
    ...partial,
  };
}

export function interfaceDown(deviceId: string, iface: string, seconds = 0): ObservedEvent {
  return event({
    deviceId,
    eventType: 'interface_down',
    attributes: { interface: iface, vrf: 'default' },
    occurredAt: at(seconds),
  });
}

export function interfaceUp(deviceId: string, iface: string, seconds = 0): ObservedEvent {
  return event({
    deviceId,
    eventType: 'interface_up',
    severity: 'info',
    attributes: { interface: iface, vrf: 'default' },
    occurredAt: at(seconds),
  });
}

export function ospfDown(deviceId: string, neighborId: string, iface: string, seconds = 0): ObservedEvent {
  return event({
    deviceId,
    eventType: 'ospf_neighbor_down',
    attributes: { neighborId, interface: iface, fromState: 'Full', toState: 'Deleted', reason: 'KillNbr' },
    occurredAt: at(seconds),
  });
}

export function ospfUp(deviceId: string, neighborId: string, iface: string, seconds = 0): ObservedEvent {
  return event({
    deviceId,
    eventType: 'ospf_neighbor_up',
    severity: 'info',
    attributes: { neighborId, interface: iface, fromState: 'Loading', toState: 'Full' },
    occurredAt: at(seconds),
  });
}

export function deviceUnreachable(deviceId: string, seconds = 0): ObservedEvent {
  return event({
    deviceId,
    eventType: 'device_unreachable',
    severity: 'critical',
    source: 'health-service',
    sourceLogId: null,
    attributes: { previousStatus: 'healthy', checkType: 'icmp' },
    occurredAt: at(seconds),
  });
}

export function deviceRecovered(deviceId: string, seconds = 0): ObservedEvent {
  return event({
    deviceId,
    eventType: 'device_recovered',
    severity: 'info',
    source: 'health-service',
    sourceLogId: null,
    attributes: { previousStatus: 'down', checkType: 'icmp' },
    occurredAt: at(seconds),
  });
}

/**
 * Scenario 01 - the R2-R3 link fails. Both routers are alive and both report
 * losing the other.
 */
export function linkFailureEvents(): ObservedEvent[] {
  return [
    interfaceDown('r2', 'eth2', 0),
    ospfDown('r2', '10.255.0.3', 'eth2', 0),
    interfaceDown('r3', 'eth1', 0),
    ospfDown('r3', '10.255.0.2', 'eth1', 0),
    deviceUnreachable('r3', 2),
    deviceUnreachable('pc2', 2),
  ];
}

/**
 * Scenario 02 - R3 itself fails. r2 reports losing it; r3 reports nothing,
 * because it is gone.
 */
export function routerFailureEvents(): ObservedEvent[] {
  return [
    interfaceDown('r2', 'eth2', 0),
    ospfDown('r2', '10.255.0.3', 'eth2', 0),
    deviceUnreachable('r3', 2),
    deviceUnreachable('pc2', 2),
  ];
}
