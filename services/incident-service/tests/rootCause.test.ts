import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferRootCause } from '../src/correlation/rootCause.js';
import {
  interfaceDown,
  linkFailureEvents,
  ospfDown,
  resetClock,
  routerFailureEvents,
} from './fixtures.js';
import type { ObservedEvent } from '../src/models/types.js';

test('both ends reporting means the link failed, not a device', () => {
  resetClock();
  const cause = inferRootCause(linkFailureEvents(), ['r3', 'pc2']);

  assert.equal(cause.type, 'link_failure');
  assert.deepEqual(cause.devices, ['r2', 'r3']);
  assert.equal(cause.confidence, 'confirmed');
  assert.match(cause.summary, /R2 <-> R3 link failure/);
});

test('one end reporting with a silent unreachable peer means that device failed', () => {
  resetClock();
  const cause = inferRootCause(routerFailureEvents(), ['r3', 'pc2']);

  assert.equal(cause.type, 'device_failure');
  assert.deepEqual(cause.devices, ['r3']);
  assert.equal(cause.confidence, 'probable');
  assert.match(cause.summary, /R3 device failure/);
});

test('the two scenarios are indistinguishable by ICMP alone', () => {
  resetClock();
  const link = inferRootCause(linkFailureEvents(), ['r3', 'pc2']);
  resetClock();
  const router = inferRootCause(routerFailureEvents(), ['r3', 'pc2']);

  // Both cut off exactly the same devices - which is why Increment 1 could not
  // tell them apart, and why the log evidence from Increment 2 is what settles
  // it. If this assertion ever fails the demo has lost its point.
  assert.deepEqual(link.predictedUnreachable, router.predictedUnreachable);
  assert.deepEqual(link.observedUnreachable, router.observedUnreachable);
  assert.notEqual(link.type, router.type);
});

test('a root cause predicts the symptoms that were actually observed', () => {
  resetClock();
  const cause = inferRootCause(linkFailureEvents(), ['r3', 'pc2']);

  assert.deepEqual(cause.predictedUnreachable, ['pc2', 'r3']);
  assert.deepEqual(cause.observedUnreachable, ['pc2', 'r3']);
  assert.equal(cause.predictionMatches, true);
});

test('a prediction that does not match observation is reported, not hidden', () => {
  resetClock();
  // A confirmed R2-R3 link failure cuts off r3 and pc2. Claiming only pc1 went
  // down contradicts that, and the mismatch has to surface.
  const cause = inferRootCause(linkFailureEvents(), ['pc1']);

  assert.equal(cause.type, 'link_failure');
  assert.equal(cause.predictionMatches, false);
});

test('the evidence explains the conclusion in plain language', () => {
  resetClock();
  const cause = inferRootCause(linkFailureEvents(), ['r3', 'pc2']);

  assert.ok(cause.evidence.length >= 2);
  assert.ok(cause.evidence.some((line) => line.includes('r2')));
  assert.ok(cause.evidence.some((line) => line.includes('r3')));
});

test('a device that is unreachable but still logging is not called a device failure', () => {
  resetClock();
  // r3 is unreachable from the monitoring host, but it is plainly alive: it is
  // still producing log events of its own.
  const events = [
    ospfDown('r2', '10.255.0.3', 'eth2', 0),
    interfaceDown('r3', 'eth1', 0),
  ];
  const cause = inferRootCause(events, ['r3']);

  assert.notEqual(cause.type, 'device_failure');
});

test('interface events alone identify the link', () => {
  resetClock();
  const events = [interfaceDown('r2', 'eth2', 0), interfaceDown('r3', 'eth1', 0)];
  const cause = inferRootCause(events, ['r3', 'pc2']);

  // zebra reports the interface dropping immediately; ospfd may take until the
  // dead timer expires. The conclusion should not have to wait for OSPF.
  assert.equal(cause.type, 'link_failure');
  assert.deepEqual(cause.devices, ['r2', 'r3']);
});

test('unexplained events produce an honest unknown rather than a guess', () => {
  resetClock();
  const cause = inferRootCause([], ['pc1']);

  assert.equal(cause.type, 'unknown');
  assert.equal(cause.confidence, 'unknown');
  assert.equal(cause.predictionMatches, false);
});

test('an adjacency event naming an unknown router-id is ignored safely', () => {
  resetClock();
  const cause = inferRootCause([ospfDown('r2', '10.255.9.9', 'eth2', 0)], []);
  assert.equal(cause.type, 'unknown');
});

test('explicit failure impact is predicted independently from observation', () => {
  const event: ObservedEvent = {
    id: 'evt-explicit',
    deviceId: 'r2',
    eventType: 'interface_admin_down',
    severity: 'warning',
    source: 'layer-zero',
    sourceLogId: 'log-explicit',
    attributes: { interface: 'eth2', adminState: 'down' },
    occurredAt: new Date('2026-08-26T20:00:00.000Z'),
  };

  const cause = inferRootCause([event], []);

  assert.equal(cause.type, 'interface_misconfiguration');
  assert.deepEqual(cause.predictedUnreachable, ['pc2', 'r3']);
  assert.deepEqual(cause.observedUnreachable, []);
  assert.equal(cause.predictionMatches, false);
});

test('configuration drift independently predicts no reachability loss', () => {
  const event: ObservedEvent = {
    id: 'evt-drift',
    deviceId: 'r2',
    eventType: 'configuration_drift',
    severity: 'warning',
    source: 'layer-zero',
    sourceLogId: 'log-drift',
    attributes: { interface: 'eth2', expected: '10', observed: '65535' },
    occurredAt: new Date('2026-08-26T20:00:00.000Z'),
  };

  const cause = inferRootCause([event], []);

  assert.deepEqual(cause.predictedUnreachable, []);
  assert.equal(cause.predictionMatches, true);
});
