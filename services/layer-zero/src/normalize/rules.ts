import type { NormalizedEvent, ParsedLogLine, Severity } from '../models/types.js';

/** An event with everything except the id of the log it was derived from. */
export type UnlinkedEvent = Omit<NormalizedEvent, 'sourceLogId'>;

/**
 * Normalization rules: a parsed FRR message becomes a network event, or
 * nothing at all.
 *
 * Returning null is the common case and is not a failure. FRR is far chattier
 * than the set of things worth reasoning about, and an event stream padded
 * with routine bookkeeping is worse than no event stream - Increment 3 has to
 * correlate against it, and Increment 4's agent has to read it.
 */

/**
 * zebra, at debug level:
 *   MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)
 *   MESSAGE: ZEBRA_INTERFACE_UP eth2 vrf default(0)
 *
 * The sibling ZEBRA_INTERFACE_ADDRESS_ADD / _DELETE messages deliberately do
 * not match: an address moving is a consequence of the link change already
 * captured, not an independent fault.
 */
const ZEBRA_INTERFACE =
  /^MESSAGE: ZEBRA_INTERFACE_(UP|DOWN) (\S+) vrf (\S+)\((\d+)\)$/;

/**
 * ospfd, with `log-adjacency-changes detail`:
 *   AdjChg: Nbr 10.255.0.3, NbrIP 10.0.23.2 (default) on eth2:10.0.23.1: Full -> Deleted (KillNbr)
 */
const OSPF_ADJACENCY =
  /^AdjChg: Nbr (\S+), NbrIP (\S+) \((\S+)\) on ([^:\s]+):(\S+): (\w+) -> (\w+) \((\w+)\)$/;

/**
 * OSPF neighbour states that mean the adjacency is gone. The intermediate
 * states of a forming adjacency (Init, ExStart, Exchange, Loading) are
 * transitional bookkeeping: a single link recovery walks through all four, and
 * emitting an event per step would bury the one transition that matters.
 */
const ADJACENCY_LOST = new Set(['Down', 'Deleted']);
const ADJACENCY_ESTABLISHED = 'Full';

/**
 * Severity reflects what the event means on its own. A down interface is a
 * strong signal but not yet an outage - whether it amounts to one is a
 * correlation question, and correlation is Increment 3's job, not Layer 0's.
 */
const SEVERITY: Record<string, Severity> = {
  interface_down: 'warning',
  interface_up: 'info',
  ospf_neighbor_down: 'warning',
  ospf_neighbor_up: 'info',
};

/**
 * Apply every rule to a parsed line. Returns the matching event, or null when
 * the line carries nothing worth recording as an event.
 */
export function normalize(deviceId: string, line: ParsedLogLine): UnlinkedEvent | null {
  return (
    interfaceRule(deviceId, line) ?? ospfAdjacencyRule(deviceId, line) ?? null
  );
}

function interfaceRule(deviceId: string, line: ParsedLogLine): UnlinkedEvent | null {
  if (line.daemon !== 'ZEBRA') return null;

  const match = ZEBRA_INTERFACE.exec(line.message);
  if (match === null) return null;

  const [, direction, iface, vrf, vrfId] = match;
  if (direction === undefined || iface === undefined || vrf === undefined) return null;

  const eventType = direction === 'DOWN' ? 'interface_down' : 'interface_up';

  return {
    deviceId,
    eventType,
    severity: SEVERITY[eventType] ?? 'info',
    attributes: {
      interface: iface,
      vrf,
      vrfId: vrfId === undefined ? null : Number.parseInt(vrfId, 10),
    },
    source: 'layer-zero',
    occurredAt: line.loggedAt,
  };
}

function ospfAdjacencyRule(deviceId: string, line: ParsedLogLine): UnlinkedEvent | null {
  if (line.daemon !== 'OSPF') return null;

  const match = OSPF_ADJACENCY.exec(line.message);
  if (match === null) return null;

  const [, neighborId, neighborIp, vrf, iface, localIp, fromState, toState, reason] = match;
  if (
    neighborId === undefined ||
    neighborIp === undefined ||
    iface === undefined ||
    fromState === undefined ||
    toState === undefined
  ) {
    return null;
  }

  const eventType = classifyAdjacency(toState);
  if (eventType === null) return null;

  return {
    deviceId,
    eventType,
    severity: SEVERITY[eventType] ?? 'info',
    attributes: {
      neighborId,
      neighborIp,
      interface: iface,
      localIp: localIp ?? null,
      vrf: vrf ?? null,
      fromState,
      toState,
      reason: reason ?? null,
    },
    source: 'layer-zero',
    occurredAt: line.loggedAt,
  };
}

function classifyAdjacency(toState: string): 'ospf_neighbor_up' | 'ospf_neighbor_down' | null {
  if (toState === ADJACENCY_ESTABLISHED) return 'ospf_neighbor_up';
  if (ADJACENCY_LOST.has(toState)) return 'ospf_neighbor_down';
  return null;
}
