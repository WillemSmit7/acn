import type { ObservedEvent, RootCause, RootCauseType } from '../models/types.js';
import {
  deviceForRouterId,
  linkBetween,
  linkEndpoints,
  linkForInterface,
  linkKey,
  predictUnreachable,
  type Link,
} from '../config/topology.js';

interface LinkReport {
  link: Link;
  reporters: Set<string>;
  interfaceReporters: Set<string>;
  adjacencyReporters: Set<string>;
  evidence: string[];
}

/**
 * Deterministic ISP-style root-cause inference. Scenario probes read the
 * changed state back from the router and emit a structured raw-log observation.
 * Native zebra and OSPF logs remain fallback and corroborating evidence.
 */
export function inferRootCause(
  events: ObservedEvent[],
  observedUnreachable: string[],
): RootCause {
  const explicit = findExplicitFailure(events, observedUnreachable);
  if (explicit !== null) return explicit;

  const reports = collectLinkReports(events);
  const confirmed = findConfirmedLinkFailure(reports);
  if (confirmed !== null) return buildLegacyLinkFailure(confirmed, observedUnreachable);

  const devicesHeardFrom = new Set(
    events.filter((event) => event.source === 'layer-zero').map((event) => event.deviceId),
  );
  const failedDevice = findSilentPeer(reports, devicesHeardFrom, observedUnreachable);
  if (failedDevice !== null) return buildLegacyDeviceFailure(failedDevice, observedUnreachable);

  return unknownCause(events, observedUnreachable);
}

const EXPLICIT_FAILURES: Record<string, { type: RootCauseType; label: string }> = {
  configuration_drift: { type: 'configuration_drift', label: 'configuration drift' },
  routing_session_down: {
    type: 'routing_session_failure',
    label: 'routing-protocol session failure',
  },
  interface_admin_down: {
    type: 'interface_misconfiguration',
    label: 'administratively disabled interface',
  },
  routing_service_down: {
    type: 'routing_service_failure',
    label: 'routing-service failure',
  },
  resource_exhaustion: {
    type: 'resource_exhaustion',
    label: 'resource exhaustion affecting network services',
  },
};

function findExplicitFailure(
  events: ObservedEvent[],
  observedUnreachable: string[],
): RootCause | null {
  for (const event of events) {
    const definition = EXPLICIT_FAILURES[event.eventType];
    if (definition === undefined) continue;
    const details = Object.entries(event.attributes)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
    return {
      type: definition.type,
      devices: [event.deviceId],
      summary: `${event.deviceId.toUpperCase()} ${definition.label}`,
      confidence: 'confirmed',
      evidence: [
        `${event.deviceId} monitor observed ${definition.label}${details.length > 0 ? ` (${details})` : ''}`,
      ],
      ...comparePrediction(observedUnreachable, observedUnreachable),
    };
  }
  return null;
}

function collectLinkReports(events: ObservedEvent[]): Map<string, LinkReport> {
  const reports = new Map<string, LinkReport>();

  const record = (
    link: Link,
    reporter: string,
    kind: 'interface' | 'adjacency',
    evidence: string,
  ): void => {
    const key = linkKey(link);
    const existing = reports.get(key);
    if (existing === undefined) {
      reports.set(key, {
        link,
        reporters: new Set([reporter]),
        interfaceReporters: new Set(kind === 'interface' ? [reporter] : []),
        adjacencyReporters: new Set(kind === 'adjacency' ? [reporter] : []),
        evidence: [evidence],
      });
      return;
    }
    existing.reporters.add(reporter);
    existing[kind === 'interface' ? 'interfaceReporters' : 'adjacencyReporters'].add(reporter);
    if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
  };

  for (const event of events) {
    if (event.eventType === 'interface_down') {
      const iface = stringAttribute(event, 'interface');
      if (iface === null) continue;
      const link = linkForInterface(event.deviceId, iface);
      if (link !== null) {
        record(link, event.deviceId, 'interface', `${event.deviceId} reported ${iface} down`);
      }
      continue;
    }

    if (event.eventType === 'ospf_neighbor_down') {
      const neighborId = stringAttribute(event, 'neighborId');
      if (neighborId === null) continue;
      const peer = deviceForRouterId(neighborId);
      if (peer === null) continue;
      const link = linkBetween(event.deviceId, peer);
      if (link !== null) {
        record(link, event.deviceId, 'adjacency', `${event.deviceId} lost OSPF adjacency with ${peer}`);
      }
    }
  }
  return reports;
}

function findConfirmedLinkFailure(reports: Map<string, LinkReport>): LinkReport | null {
  for (const report of reports.values()) {
    const [a, b] = linkEndpoints(report.link);
    if (report.reporters.has(a) && report.reporters.has(b)) return report;
  }
  return null;
}

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
    if (silent !== null && unreachable.has(silent) && !devicesHeardFrom.has(silent)) {
      return { device: silent, report };
    }
  }
  return null;
}

function buildLegacyLinkFailure(report: LinkReport, observedUnreachable: string[]): RootCause {
  const [a, b] = linkEndpoints(report.link);
  const predicted = predictUnreachable(new Set([linkKey(report.link)]), new Set());
  return {
    type: 'link_failure',
    devices: [a, b].sort(),
    summary: `${a.toUpperCase()} <-> ${b.toUpperCase()} link failure`,
    confidence: 'confirmed',
    evidence: [...report.evidence, 'both ends reported independently'],
    ...comparePrediction(predicted, observedUnreachable),
  };
}

function buildLegacyDeviceFailure(
  found: { device: string; report: LinkReport },
  observedUnreachable: string[],
): RootCause {
  const predicted = predictUnreachable(new Set(), new Set([found.device]));
  return {
    type: 'device_failure',
    devices: [found.device],
    summary: `${found.device.toUpperCase()} device failure`,
    confidence: 'probable',
    evidence: [...found.report.evidence, `${found.device} was silent and unreachable`],
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
    evidence: ['no requested ISP failure category could be identified from the evidence'],
    predictedUnreachable: [],
    observedUnreachable: [...observedUnreachable].sort(),
    predictionMatches: false,
  };
}

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
