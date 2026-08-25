import type { ObservedEvent, RootCause } from '../models/types.js';
import {
  deviceForRouterId,
  linkBetween,
  linkEndpoints,
  linkForInterface,
  linkKey,
  predictUnreachable,
  type Link,
} from '../config/topology.js';

/**
 * Deterministic root-cause inference.
 *
 * No LLM here, deliberately. Increment 3 establishes a correlation baseline
 * that is explainable and reproducible; Claude arrives in Increment 4 as an
 * investigator over incidents that already exist. An inference nobody can
 * reproduce is not a baseline.
 *
 * The discriminating question is simple, and it is the whole reason Increment 2
 * had to happen: **did the far end of the link corroborate?**
 *
 *   Link failure  - r2 reports losing r3 AND r3 reports losing r2.
 *                   Both ends are alive to complain about each other.
 *   Device failure - r2 reports losing r3, r3 reports nothing at all, and r3 is
 *                   itself unreachable. A dead router cannot file a report.
 *
 * ICMP alone cannot tell these apart: both cut off exactly the same devices, so
 * both produce an identical set of device_unreachable events. That is precisely
 * what predictedUnreachable makes visible.
 */

/** A device's claim that a specific link is broken. */
interface LinkReport {
  link: Link;
  reporters: Set<string>;
  evidence: string[];
}

export function inferRootCause(
  events: ObservedEvent[],
  observedUnreachable: string[],
): RootCause {
  const reports = collectLinkReports(events);
  const devicesHeardFrom = new Set(
    events.filter((event) => event.source === 'layer-zero').map((event) => event.deviceId),
  );

  const confirmed = findConfirmedLinkFailure(reports);
  if (confirmed !== null) {
    return buildLinkFailure(confirmed, observedUnreachable);
  }

  const failedDevice = findSilentPeer(reports, devicesHeardFrom, observedUnreachable);
  if (failedDevice !== null) {
    return buildDeviceFailure(failedDevice, observedUnreachable);
  }

  return unknownCause(events, observedUnreachable);
}

/**
 * Turn interface and adjacency events into per-link reports.
 *
 * Both event types are used because they answer the same question at different
 * speeds: zebra reports the interface dropping immediately, while ospfd may
 * only notice when the dead timer expires.
 */
function collectLinkReports(events: ObservedEvent[]): Map<string, LinkReport> {
  const reports = new Map<string, LinkReport>();

  const record = (link: Link, reporter: string, evidence: string): void => {
    const key = linkKey(link);
    const existing = reports.get(key);
    if (existing === undefined) {
      reports.set(key, { link, reporters: new Set([reporter]), evidence: [evidence] });
      return;
    }
    existing.reporters.add(reporter);
    if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
  };

  for (const event of events) {
    if (event.eventType === 'interface_down') {
      const iface = stringAttribute(event, 'interface');
      if (iface === null) continue;

      const link = linkForInterface(event.deviceId, iface);
      if (link === null) continue;

      record(link, event.deviceId, `${event.deviceId} reported ${iface} down`);
      continue;
    }

    if (event.eventType === 'ospf_neighbor_down') {
      const neighborId = stringAttribute(event, 'neighborId');
      if (neighborId === null) continue;

      const peer = deviceForRouterId(neighborId);
      if (peer === null) continue;

      const link = linkBetween(event.deviceId, peer);
      if (link === null) continue;

      record(link, event.deviceId, `${event.deviceId} lost OSPF adjacency with ${peer}`);
    }
  }

  return reports;
}

/** A link both of whose endpoints independently reported it broken. */
function findConfirmedLinkFailure(reports: Map<string, LinkReport>): LinkReport | null {
  for (const report of reports.values()) {
    const [a, b] = linkEndpoints(report.link);
    if (report.reporters.has(a) && report.reporters.has(b)) return report;
  }
  return null;
}

/**
 * A link reported broken from one side only, where the silent side is
 * unreachable and has produced no logs of its own. The natural reading is that
 * the silent device failed rather than the link between them.
 */
function findSilentPeer(
  reports: Map<string, LinkReport>,
  devicesHeardFrom: Set<string>,
  observedUnreachable: string[],
): { device: string; report: LinkReport } | null {
  const unreachable = new Set(observedUnreachable);

  for (const report of reports.values()) {
    const [a, b] = linkEndpoints(report.link);
    const silent = report.reporters.has(a) && !report.reporters.has(b) ? b :
                   report.reporters.has(b) && !report.reporters.has(a) ? a : null;
    if (silent === null) continue;

    if (unreachable.has(silent) && !devicesHeardFrom.has(silent)) {
      return { device: silent, report };
    }
  }

  return null;
}

function buildLinkFailure(report: LinkReport, observedUnreachable: string[]): RootCause {
  const [a, b] = linkEndpoints(report.link);
  const predicted = predictUnreachable(new Set([linkKey(report.link)]), new Set());

  return {
    type: 'link_failure',
    devices: [a, b].sort(),
    summary: `${a.toUpperCase()} <-> ${b.toUpperCase()} link failure`,
    confidence: 'confirmed',
    evidence: [
      ...report.evidence,
      `both ends reported independently, so both devices are alive - the link between them is not`,
    ],
    ...comparePrediction(predicted, observedUnreachable),
  };
}

function buildDeviceFailure(
  found: { device: string; report: LinkReport },
  observedUnreachable: string[],
): RootCause {
  const { device, report } = found;
  const predicted = predictUnreachable(new Set(), new Set([device]));

  return {
    type: 'device_failure',
    devices: [device],
    summary: `${device.toUpperCase()} device failure`,
    confidence: 'probable',
    evidence: [
      ...report.evidence,
      `${device} reported nothing of its own and is unreachable - a failed device cannot report its own failure`,
    ],
    ...comparePrediction(predicted, observedUnreachable),
  };
}

function unknownCause(events: ObservedEvent[], observedUnreachable: string[]): RootCause {
  const devices = [...new Set(events.map((event) => event.deviceId))].sort();

  return {
    type: 'unknown',
    devices,
    summary:
      observedUnreachable.length > 0
        ? `Unexplained loss of ${observedUnreachable.join(', ')}`
        : 'Unexplained network events',
    confidence: 'unknown',
    evidence: ['no link or device could be identified from the events seen'],
    predictedUnreachable: [],
    observedUnreachable: [...observedUnreachable].sort(),
    predictionMatches: false,
  };
}

/**
 * Check the inference against reality. If a root cause does not predict the
 * symptoms that were actually observed, that mismatch is recorded rather than
 * hidden - it is the signal that the correlation rules need work.
 */
function comparePrediction(
  predicted: string[],
  observed: string[],
): Pick<RootCause, 'predictedUnreachable' | 'observedUnreachable' | 'predictionMatches'> {
  const predictedSorted = [...predicted].sort();
  const observedSorted = [...observed].sort();

  return {
    predictedUnreachable: predictedSorted,
    observedUnreachable: observedSorted,
    predictionMatches:
      predictedSorted.length === observedSorted.length &&
      predictedSorted.every((device, index) => device === observedSorted[index]),
  };
}

function stringAttribute(event: ObservedEvent, name: string): string | null {
  const value = event.attributes[name];
  return typeof value === 'string' ? value : null;
}
