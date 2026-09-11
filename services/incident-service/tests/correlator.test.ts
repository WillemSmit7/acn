import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Correlator } from '../src/correlation/correlator.js';
import type { ObservedEvent } from '../src/models/types.js';
import {
  deviceRecovered,
  deviceUnreachable,
  interfaceDown,
  interfaceUp,
  linkFailureEvents,
  ospfDown,
  ospfUp,
  resetClock,
  routerFailureEvents,
} from './fixtures.js';

const OPTIONS = { correlationWindowMs: 120_000, settleMs: 10_000 };

/** The moment after which an incident is considered settled. */
function afterSettle(seconds = 60): Date {
  return new Date(Date.UTC(2026, 7, 25, 20, 0, 0) + seconds * 1000);
}

test('related events across devices collapse into one incident', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  for (const event of linkFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle());

  const incidents = [...correlator.openIncidents(), ...correlator.resolvedIncidents()];
  assert.equal(incidents.length, 1, 'one fault should produce one incident');
  assert.equal(incidents[0]?.eventCount, 6);
  assert.deepEqual(incidents[0]?.affectedDevices, ['pc2', 'r2', 'r3']);
});

test('incidents are numbered sequentially and used as the document id', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  correlator.observe(interfaceDown('r2', 'eth2', 0));
  correlator.tick(afterSettle());

  const all = [...correlator.openIncidents(), ...correlator.resolvedIncidents()];
  assert.equal(all[0]?.incidentId, 'INC-001');
});

test('numbering continues from existing incidents after a restart', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  correlator.seedSequence(7);
  correlator.observe(interfaceDown('r2', 'eth2', 0));

  assert.equal(correlator.openIncidents()[0]?.incidentId, 'INC-008');
});

test('severity stays a warning when nothing became unreachable', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  correlator.observe(interfaceDown('r1', 'eth1', 0));
  correlator.tick(afterSettle());

  const all = [...correlator.openIncidents(), ...correlator.resolvedIncidents()];
  assert.equal(all[0]?.severity, 'warning');
});

test('the root cause is not judged before the settle window elapses', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);

  // Only r2 has reported so far. Concluding now would call this a device
  // failure; r3's corroboration is still in flight.
  correlator.observe(interfaceDown('r2', 'eth2', 0));
  correlator.observe(ospfDown('r2', '10.255.0.3', 'eth2', 0));
  correlator.observe(deviceUnreachable('r3', 1));
  correlator.tick(new Date(Date.UTC(2026, 7, 25, 20, 0, 2)));

  assert.equal(correlator.openIncidents()[0]?.rootCause.type, 'analyzing');
});

test('a late corroborating report still lands in the same incident', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  correlator.observe(interfaceDown('r2', 'eth2', 0));
  correlator.observe(ospfDown('r2', '10.255.0.3', 'eth2', 0));
  correlator.observe(deviceUnreachable('r3', 1));
  correlator.tick(new Date(Date.UTC(2026, 7, 25, 20, 0, 2)));

  // r3's side arrives a few seconds later, before the window closes.
  correlator.observe(interfaceDown('r3', 'eth1', 4));
  correlator.observe(ospfDown('r3', '10.255.0.2', 'eth1', 4));
  correlator.tick(afterSettle());

  const incidents = correlator.openIncidents();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.rootCause.type, 'link_failure');
});

test('a link failure and a router failure produce different root causes', () => {
  resetClock();
  const link = new Correlator(OPTIONS);
  for (const event of linkFailureEvents()) link.observe(event);
  link.tick(afterSettle());

  resetClock();
  const router = new Correlator(OPTIONS);
  for (const event of routerFailureEvents()) router.observe(event);
  router.tick(afterSettle());

  assert.equal(link.openIncidents()[0]?.rootCause.type, 'link_failure');
  assert.equal(router.openIncidents()[0]?.rootCause.type, 'device_failure');
});

test('an incident resolves once every fault it covers has recovered', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  for (const event of linkFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle(30));

  assert.equal(correlator.openIncidents()[0]?.status, 'open');

  correlator.observe(interfaceUp('r2', 'eth2', 40));
  correlator.observe(ospfUp('r2', '10.255.0.3', 'eth2', 40));
  correlator.observe(interfaceUp('r3', 'eth1', 40));
  correlator.observe(ospfUp('r3', '10.255.0.2', 'eth1', 40));
  correlator.observe(deviceRecovered('r3', 42));
  correlator.observe(deviceRecovered('pc2', 42));
  correlator.tick(afterSettle(120));

  assert.equal(correlator.openIncidents().length, 0);
  const resolved = correlator.resolvedIncidents();
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.status, 'resolved');
  assert.notEqual(resolved[0]?.resolvedAt, null);
});

test('an incident stays open while any device is still unreachable', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  for (const event of linkFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle(30));

  // Everything recovers except pc2.
  correlator.observe(interfaceUp('r2', 'eth2', 40));
  correlator.observe(ospfUp('r2', '10.255.0.3', 'eth2', 40));
  correlator.observe(interfaceUp('r3', 'eth1', 40));
  correlator.observe(ospfUp('r3', '10.255.0.2', 'eth1', 40));
  correlator.observe(deviceRecovered('r3', 42));
  correlator.tick(afterSettle(120));

  assert.equal(correlator.openIncidents().length, 1);
  assert.deepEqual(correlator.openIncidents()[0]?.unreachableDevices, ['pc2']);
});

test('unrelated faults on distant devices do not merge', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);

  // pc1 and pc2 sit at opposite ends of the topology and are not adjacent.
  correlator.observe(deviceUnreachable('pc1', 0));
  correlator.observe(deviceUnreachable('pc2', 1));
  correlator.tick(afterSettle());

  assert.equal(correlator.openIncidents().length, 2);
});

test('events outside the correlation window start a new incident', () => {
  resetClock();
  const correlator = new Correlator({ correlationWindowMs: 5_000, settleMs: 1_000 });

  correlator.observe(interfaceDown('r2', 'eth2', 0));
  correlator.observe(interfaceDown('r2', 'eth2', 600));
  correlator.tick(afterSettle(900));

  assert.equal(
    correlator.openIncidents().length + correlator.resolvedIncidents().length,
    2,
  );
});

test('a recovery with no matching incident is ignored', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  assert.equal(correlator.observe(deviceRecovered('r3', 0)), null);
  assert.equal(correlator.openIncidents().length, 0);
});

test('severity escalates to critical when a device becomes unreachable', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);

  correlator.observe(interfaceDown('r2', 'eth2', 0));
  assert.equal(correlator.openIncidents()[0]?.severity, 'warning');

  correlator.observe(deviceUnreachable('r3', 1));
  assert.equal(correlator.openIncidents()[0]?.severity, 'critical');
});

test('symptoms read as plain statements about the network', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  for (const event of linkFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle());

  const symptoms = correlator.openIncidents()[0]?.symptoms ?? [];
  assert.ok(symptoms.includes('r3 unreachable'));
  assert.ok(symptoms.includes('pc2 unreachable'));
  assert.ok(symptoms.includes('r2 eth2 down'));
});

test('every attached event id is retained for traceability', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  const events = linkFailureEvents();
  for (const event of events) correlator.observe(event);
  correlator.tick(afterSettle());

  // The incident must be able to point at the exact events behind it, which in
  // turn point at the raw log lines through sourceLogId.
  const incident = correlator.openIncidents()[0];
  assert.deepEqual(incident?.eventIds, events.map((event) => event.id));
});

test('a recovered router does not retrospectively exonerate itself', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);

  // Scenario 02: r3 is stopped, so only r2 reports. Correctly a device failure.
  for (const event of routerFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle(30));
  assert.equal(correlator.openIncidents()[0]?.rootCause.type, 'device_failure');

  // r3 is brought back. It boots, its link re-establishes, and it starts
  // logging interface and adjacency events of its own. Naively re-inferring
  // now would see both ends reporting and call this a link failure - which
  // would be wrong, and would erase the one conclusion that mattered.
  correlator.observe(interfaceDown('r3', 'eth1', 40));
  correlator.observe(interfaceUp('r3', 'eth1', 41));
  correlator.observe(interfaceUp('r2', 'eth2', 41));
  correlator.observe(ospfUp('r2', '10.255.0.3', 'eth2', 45));
  correlator.observe(ospfUp('r3', '10.255.0.2', 'eth1', 45));
  correlator.observe(deviceRecovered('r3', 47));
  correlator.observe(deviceRecovered('pc2', 47));
  correlator.tick(afterSettle(120));

  const all = [...correlator.openIncidents(), ...correlator.resolvedIncidents()];
  assert.equal(all[0]?.rootCause.type, 'device_failure');
  assert.deepEqual(all[0]?.rootCause.devices, ['r3']);
});

test('a fault well after a recovering incident starts a new incident', () => {
  resetClock();
  const correlator = new Correlator({ correlationWindowMs: 30_000, settleMs: 5_000 });

  for (const event of linkFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle(20));

  // A long recovery tail must not keep the absorption window open forever: the
  // window is measured from the last FAULT, not the last event of any kind.
  correlator.observe(deviceRecovered('r3', 60));
  correlator.observe(deviceRecovered('pc2', 61));
  correlator.tick(afterSettle(90));

  correlator.observe(interfaceDown('r1', 'eth1', 200));
  correlator.tick(afterSettle(260));

  const all = [...correlator.openIncidents(), ...correlator.resolvedIncidents()];
  assert.equal(all.length, 2, 'the later fault should be its own incident');
});

test('an incident resolves even when a recovery event never arrives', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  for (const event of linkFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle(20));

  // Only the ICMP recoveries arrive. The interface_up / ospf_neighbor_up events
  // are missing entirely - which really happens when the collector reattaches
  // its tail while the lab is being redeployed.
  correlator.observe(deviceRecovered('r3', 40));
  correlator.observe(deviceRecovered('pc2', 40));
  correlator.tick(afterSettle(120));

  const resolved = correlator.resolvedIncidents();
  assert.equal(resolved.length, 1, 'reachability, not fault bookkeeping, closes an incident');
  assert.equal(resolved[0]?.status, 'resolved');
});

test('a trailing interface_down from the same second does not hang the incident', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  for (const event of linkFailureEvents()) correlator.observe(event);
  correlator.tick(afterSettle(20));

  // FRR stamps its logs to the second, so a down/up pair inside one second can
  // be delivered in either order. Here the "up" is seen before the "down".
  correlator.observe(interfaceUp('r2', 'eth2', 40));
  correlator.observe(interfaceDown('r2', 'eth2', 40));
  correlator.observe(deviceRecovered('r3', 42));
  correlator.observe(deviceRecovered('pc2', 42));
  correlator.tick(afterSettle(120));

  assert.equal(correlator.resolvedIncidents().length, 1);
});

test('an incident with no unreachability closes itself after the network settles', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);

  // A link flap that never cost reachability is still an incident worth
  // recording, but it must not stay open forever waiting for a recovery.
  correlator.observe(interfaceDown('r1', 'eth1', 0));
  correlator.tick(afterSettle(60));

  assert.equal(correlator.resolvedIncidents().length, 1);
});

test('a persistent state fault stays open until its matching recovery is observed', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  const drift: ObservedEvent = {
    id: 'evt-drift',
    deviceId: 'r2',
    eventType: 'configuration_drift',
    severity: 'warning',
    source: 'layer-zero',
    sourceLogId: 'log-drift',
    attributes: { interface: 'eth2', expected: '10', observed: '65535' },
    occurredAt: afterSettle(0),
  };
  correlator.observe(drift);

  correlator.tick(afterSettle(60));
  assert.equal(correlator.openIncidents()[0]?.status, 'open');
  assert.equal(correlator.resolvedIncidents().length, 0);

  correlator.observe({
    ...drift,
    id: 'evt-restored',
    eventType: 'configuration_restored',
    severity: 'info',
    occurredAt: afterSettle(61),
  });
  correlator.tick(afterSettle(80));

  assert.equal(correlator.openIncidents().length, 0);
  assert.equal(correlator.resolvedIncidents()[0]?.status, 'resolved');
});

test('a frozen cause still updates its independently observed impact', () => {
  resetClock();
  const correlator = new Correlator(OPTIONS);
  const fault: ObservedEvent = {
    id: 'evt-interface-admin',
    deviceId: 'r2',
    eventType: 'interface_admin_down',
    severity: 'warning',
    source: 'layer-zero',
    sourceLogId: 'log-interface-admin',
    attributes: { interface: 'eth2', adminState: 'down' },
    occurredAt: afterSettle(0),
  };
  correlator.observe(fault);
  correlator.tick(afterSettle(20));

  let incident = correlator.openIncidents()[0];
  assert.deepEqual(incident?.rootCause.predictedUnreachable, ['pc2', 'r3']);
  assert.deepEqual(incident?.rootCause.observedUnreachable, []);
  assert.equal(incident?.rootCause.predictionMatches, false);

  correlator.observe(deviceUnreachable('r3', 21));
  correlator.observe(deviceUnreachable('pc2', 21));
  correlator.tick(afterSettle(40));

  incident = correlator.openIncidents()[0];
  assert.equal(incident?.rootCause.type, 'interface_misconfiguration');
  assert.deepEqual(incident?.rootCause.observedUnreachable, ['pc2', 'r3']);
  assert.equal(incident?.rootCause.predictionMatches, true);
});
