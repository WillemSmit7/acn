import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrrLine } from '../src/normalize/parser.js';
import { normalize } from '../src/normalize/rules.js';
import type { ParsedLogLine } from '../src/models/types.js';

/** Parse a real FRR line and normalize it in one step, as the pipeline does. */
function eventFrom(deviceId: string, line: string) {
  const parsed = parseFrrLine(line);
  assert.notEqual(parsed, null, `fixture failed to parse: ${line}`);
  return normalize(deviceId, parsed as ParsedLogLine);
}

const ADJ_PREFIX = 'AdjChg: Nbr 10.255.0.3, NbrIP 10.0.23.2 (default) on eth2:10.0.23.1';

function adjacencyLine(transition: string): string {
  return `2026/08/25 19:13:33 OSPF: [Y05P2-YJVXY] ${ADJ_PREFIX}: ${transition}`;
}

function zebraLine(direction: 'UP' | 'DOWN'): string {
  return `2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_${direction} eth2 vrf default(0)`;
}

test('ZEBRA_INTERFACE_DOWN becomes an interface_down event', () => {
  const event = eventFrom('r2', zebraLine('DOWN'));

  assert.equal(event?.eventType, 'interface_down');
  assert.equal(event?.severity, 'warning');
  assert.equal(event?.deviceId, 'r2');
  assert.equal(event?.source, 'layer-zero');
  assert.equal(event?.attributes['interface'], 'eth2');
  assert.equal(event?.attributes['vrf'], 'default');
  assert.equal(event?.attributes['vrfId'], 0);
});

test('ZEBRA_INTERFACE_UP becomes an interface_up event', () => {
  const event = eventFrom('r2', zebraLine('UP'));

  assert.equal(event?.eventType, 'interface_up');
  assert.equal(event?.severity, 'info');
  assert.equal(event?.attributes['interface'], 'eth2');
});

test('a lost OSPF adjacency becomes ospf_neighbor_down', () => {
  const event = eventFrom('r2', adjacencyLine('Full -> Deleted (KillNbr)'));

  assert.equal(event?.eventType, 'ospf_neighbor_down');
  assert.equal(event?.severity, 'warning');
  assert.equal(event?.attributes['neighborId'], '10.255.0.3');
  assert.equal(event?.attributes['neighborIp'], '10.0.23.2');
  assert.equal(event?.attributes['interface'], 'eth2');
  assert.equal(event?.attributes['localIp'], '10.0.23.1');
  assert.equal(event?.attributes['fromState'], 'Full');
  assert.equal(event?.attributes['toState'], 'Deleted');
  assert.equal(event?.attributes['reason'], 'KillNbr');
});

test('an adjacency reaching Full becomes ospf_neighbor_up', () => {
  const event = eventFrom('r2', adjacencyLine('Loading -> Full (LoadingDone)'));

  assert.equal(event?.eventType, 'ospf_neighbor_up');
  assert.equal(event?.severity, 'info');
  assert.equal(event?.attributes['toState'], 'Full');
});

test('a dead-timer expiry to Down also counts as a lost adjacency', () => {
  const event = eventFrom('r2', adjacencyLine('Full -> Down (InactivityTimer)'));

  assert.equal(event?.eventType, 'ospf_neighbor_down');
  assert.equal(event?.attributes['reason'], 'InactivityTimer');
});

test('the intermediate states of a forming adjacency emit nothing', () => {
  // One link recovery walks through all four of these. Emitting an event per
  // step would bury the single transition that actually matters.
  for (const transition of [
    'Down -> Init (HelloReceived)',
    'Init -> ExStart (2-WayReceived)',
    'ExStart -> Exchange (NegotiationDone)',
    'Exchange -> Loading (ExchangeDone)',
  ]) {
    assert.equal(eventFrom('r2', adjacencyLine(transition)), null, transition);
  }
});

test('a full down-and-up cycle emits exactly one down and one up event', () => {
  const cycle = [
    zebraLine('DOWN'),
    adjacencyLine('Full -> Deleted (KillNbr)'),
    zebraLine('UP'),
    adjacencyLine('Down -> Init (HelloReceived)'),
    adjacencyLine('Init -> ExStart (2-WayReceived)'),
    adjacencyLine('ExStart -> Exchange (NegotiationDone)'),
    adjacencyLine('Exchange -> Loading (ExchangeDone)'),
    adjacencyLine('Loading -> Full (LoadingDone)'),
  ];

  const types = cycle
    .map((line) => eventFrom('r2', line))
    .filter((event) => event !== null)
    .map((event) => event.eventType);

  assert.deepEqual(types, [
    'interface_down',
    'ospf_neighbor_down',
    'interface_up',
    'ospf_neighbor_up',
  ]);
});

test('interface address churn is not an event of its own', () => {
  // Emitted alongside a real link change; it is a consequence, not a fault.
  const event = eventFrom(
    'r2',
    '2026/08/25 19:14:43 ZEBRA: [XN0NB-2NSYE] MESSAGE: ZEBRA_INTERFACE_ADDRESS_DELETE ' +
      '10.0.23.1/30 on eth2 vrf default(0)',
  );
  assert.equal(event, null);
});

test('routine zebra bookkeeping produces no event', () => {
  const event = eventFrom(
    'r2',
    '2026/08/25 19:14:43 ZEBRA: [QR5K4-A1079] rib_update_table: IPv4 VRF default ' +
      'Table 254 event RIB_UPDATE_KERNEL Route type: wildcard',
  );
  assert.equal(event, null);
});

test('an OSPF-shaped message from the wrong daemon does not match', () => {
  // The rules key off the emitting daemon as well as the text, so a message
  // that merely looks like an adjacency change cannot be misattributed.
  const parsed: ParsedLogLine = {
    loggedAt: new Date('2026-08-25T19:13:33Z'),
    daemon: 'ZEBRA',
    code: 'Y05P2-YJVXY',
    errorCode: null,
    message: `${ADJ_PREFIX}: Full -> Deleted (KillNbr)`,
  };
  assert.equal(normalize('r2', parsed), null);
});

test('the event carries the device timestamp, not the collection time', () => {
  const event = eventFrom('r2', zebraLine('DOWN'));
  assert.equal(event?.occurredAt.toISOString(), '2026-08-25T19:14:43.000Z');
});
