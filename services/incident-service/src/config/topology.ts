/**
 * The lab's physical topology.
 *
 *   PC1 --- R1 --- R2 --- R3 --- PC2
 *
 * Correlation needs to know which devices are adjacent and which interface
 * faces which peer, because that is what turns a pile of independent events
 * into a statement about a specific link. This is the single source of truth
 * for adjacency; it mirrors lab/topology.clab.yml.
 */

export interface Endpoint {
  deviceId: string;
  /** Interface on that device facing the other end. */
  interface: string;
}

export interface Link {
  a: Endpoint;
  b: Endpoint;
}

export const links: Link[] = [
  { a: { deviceId: 'pc1', interface: 'eth1' }, b: { deviceId: 'r1', interface: 'eth1' } },
  { a: { deviceId: 'r1', interface: 'eth2' }, b: { deviceId: 'r2', interface: 'eth1' } },
  { a: { deviceId: 'r2', interface: 'eth2' }, b: { deviceId: 'r3', interface: 'eth1' } },
  { a: { deviceId: 'r3', interface: 'eth2' }, b: { deviceId: 'pc2', interface: 'eth1' } },
];

export const allDevices: string[] = ['r1', 'r2', 'r3', 'pc1', 'pc2'];

/**
 * OSPF router-id -> device id. FRR names neighbours by router-id, which in this
 * lab is the loopback address, so adjacency events have to be translated back
 * to a device before they mean anything.
 */
const ROUTER_IDS: Record<string, string> = {
  '10.255.0.1': 'r1',
  '10.255.0.2': 'r2',
  '10.255.0.3': 'r3',
};

/**
 * Where the monitoring host enters the data plane. Host routes point at r1, so
 * reachability is judged from r1 outwards - see lab/deploy.sh.
 */
export const OBSERVATION_ROOT = 'r1';

export function deviceForRouterId(routerId: string): string | null {
  return ROUTER_IDS[routerId] ?? null;
}

/** Canonical key for a link, order-independent. */
export function linkKey(link: Link): string {
  return [link.a.deviceId, link.b.deviceId].sort().join('--');
}

export function linkEndpoints(link: Link): [string, string] {
  return [link.a.deviceId, link.b.deviceId];
}

/** The link a given interface belongs to, or null if it is not an inter-device link. */
export function linkForInterface(deviceId: string, iface: string): Link | null {
  return (
    links.find(
      (link) =>
        (link.a.deviceId === deviceId && link.a.interface === iface) ||
        (link.b.deviceId === deviceId && link.b.interface === iface),
    ) ?? null
  );
}

/** The link joining two devices, if they are directly connected. */
export function linkBetween(deviceA: string, deviceB: string): Link | null {
  return (
    links.find(
      (link) =>
        (link.a.deviceId === deviceA && link.b.deviceId === deviceB) ||
        (link.a.deviceId === deviceB && link.b.deviceId === deviceA),
    ) ?? null
  );
}

export function areAdjacent(deviceA: string, deviceB: string): boolean {
  return linkBetween(deviceA, deviceB) !== null;
}

/** The other end of a link from the given device. */
export function peerAcross(link: Link, deviceId: string): string | null {
  if (link.a.deviceId === deviceId) return link.b.deviceId;
  if (link.b.deviceId === deviceId) return link.a.deviceId;
  return null;
}

/**
 * Devices still reachable from the observation root once the given links and
 * devices are removed from the graph.
 *
 * This is what lets an incident state a *prediction* - "if the R2-R3 link is
 * down, r3 and pc2 should be unreachable" - which can then be checked against
 * what was actually observed. A root cause that does not predict the observed
 * symptoms is a root cause worth doubting.
 */
export function reachableFrom(
  root: string,
  removedLinkKeys: Set<string>,
  removedDevices: Set<string>,
): Set<string> {
  const reached = new Set<string>();
  if (removedDevices.has(root)) return reached;

  const queue: string[] = [root];
  reached.add(root);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    for (const link of links) {
      if (removedLinkKeys.has(linkKey(link))) continue;

      const peer = peerAcross(link, current);
      if (peer === null || reached.has(peer) || removedDevices.has(peer)) continue;

      reached.add(peer);
      queue.push(peer);
    }
  }

  return reached;
}

/** Devices that would be cut off from the observation root by a given failure. */
export function predictUnreachable(
  removedLinkKeys: Set<string>,
  removedDevices: Set<string>,
): string[] {
  const reachable = reachableFrom(OBSERVATION_ROOT, removedLinkKeys, removedDevices);
  return allDevices.filter((device) => !reachable.has(device)).sort();
}
