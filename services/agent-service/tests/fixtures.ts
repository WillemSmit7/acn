import type {
  AgentConclusion,
  EvidenceBundle,
  InvestigableIncident,
  ModelResult,
} from '../src/models/types.js';

/**
 * Incident and raw-line fixtures captured from the real Increment 3 lab runs.
 * The FRR lines are verbatim fixtures shared with Layer 0's parser tests.
 */
export const linkIncident: InvestigableIncident = {
  incidentId: 'INC-001',
  status: 'resolved',
  severity: 'critical',
  symptoms: ['r2 eth2 down', 'r3 eth1 down', 'r3 unreachable', 'pc2 unreachable'],
  affectedDevices: ['pc2', 'r2', 'r3'],
  eventIds: ['evt-r2-if', 'evt-r2-ospf', 'evt-r3-if', 'evt-r3-ospf', 'evt-r3-icmp', 'evt-pc2-icmp'],
  rootCause: {
    type: 'interface_misconfiguration',
    devices: ['r2', 'r3'],
    summary: 'R2 <-> R3 link failure',
    confidence: 'confirmed',
    evidence: [
      'r2 reported eth2 down',
      'r2 lost OSPF adjacency with r3',
      'r3 lost OSPF adjacency with r2',
      'r3 reported eth1 down',
      'both ends reported independently, so both devices are alive - the link between them is not',
    ],
    predictedUnreachable: ['pc2', 'r3'],
    observedUnreachable: ['pc2', 'r3'],
    predictionMatches: true,
  },
};

export const linkEvidence: EvidenceBundle = {
  events: [
    event('evt-r2-if', 'r2', 'interface_down', 'log-r2-if', { interface: 'eth2' }),
    event('evt-r2-ospf', 'r2', 'ospf_neighbor_down', 'log-r2-ospf', {
      interface: 'eth2', neighborId: '10.255.0.3',
    }),
    event('evt-r3-if', 'r3', 'interface_down', 'log-r3-if', { interface: 'eth1' }),
    event('evt-r3-ospf', 'r3', 'ospf_neighbor_down', 'log-r3-ospf', {
      interface: 'eth1', neighborId: '10.255.0.2',
    }),
    event('evt-r3-icmp', 'r3', 'device_unreachable', null, {}),
    event('evt-pc2-icmp', 'pc2', 'device_unreachable', null, {}),
  ],
  logs: [
    log(
      'log-r2-if',
      'r2',
      '2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)',
      'ZEBRA',
    ),
    log(
      'log-r2-ospf',
      'r2',
      '2026/08/25 19:13:33 OSPF: [Y05P2-YJVXY] AdjChg: Nbr 10.255.0.3, NbrIP 10.0.23.2 (default) on eth2:10.0.23.1: Full -> Deleted (KillNbr)',
      'OSPF',
    ),
    log(
      'log-r3-if',
      'r3',
      '2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_DOWN eth1 vrf default(0)',
      'ZEBRA',
    ),
    log(
      'log-r3-ospf',
      'r3',
      '2026/08/25 19:13:33 OSPF: [Y05P2-YJVXY] AdjChg: Nbr 10.255.0.2, NbrIP 10.0.23.1 (default) on eth1:10.0.23.2: Full -> Deleted (KillNbr)',
      'OSPF',
    ),
  ],
};

export const agreeingConclusion: AgentConclusion = {
  rootCauseType: 'interface_misconfiguration',
  rootCauseDevices: ['r3', 'r2'],
  summary: 'The R2-R3 link failed while both routers remained alive',
  confidence: 'high',
  reasoning: ['Both endpoints independently logged the interface and adjacency loss.'],
  citedEventIds: ['evt-r2-ospf', 'evt-r3-ospf'],
  citedLogIds: ['log-r2-ospf', 'log-r3-ospf'],
};

export function modelResult(conclusion = agreeingConclusion): ModelResult {
  return {
    responseId: 'resp_test',
    responseModel: 'gpt-5.6-luna',
    conclusion,
    usage: {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 200,
      reasoningTokens: 80,
      totalTokens: 1200,
    },
    latencyMs: 123,
    estimatedCostUsd: 0.00044,
  };
}

function event(
  id: string,
  deviceId: string,
  eventType: string,
  sourceLogId: string | null,
  attributes: Record<string, unknown>,
) {
  return {
    id,
    deviceId,
    eventType,
    severity: eventType === 'device_unreachable' ? 'critical' : 'warning',
    source: sourceLogId === null ? 'health-service' as const : 'layer-zero' as const,
    sourceLogId,
    attributes,
    occurredAt: '2026-08-25T19:14:43.000Z',
  };
}

function log(id: string, deviceId: string, raw: string, daemon: string) {
  return { id, deviceId, raw, daemon, loggedAt: '2026-08-25T19:14:43.000Z' };
}
