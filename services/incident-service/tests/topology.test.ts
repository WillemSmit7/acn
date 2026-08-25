import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areAdjacent,
  deviceForRouterId,
  linkBetween,
  linkForInterface,
  linkKey,
  predictUnreachable,
} from '../src/config/topology.js';

test('interfaces resolve to the link they belong to', () => {
  // r2:eth2 faces r3 - the naming matters and is asserted in lab/topology.clab.yml.
  const link = linkForInterface('r2', 'eth2');
  assert.deepEqual(link && linkKey(link), 'r2--r3');

  const other = linkForInterface('r2', 'eth1');
  assert.deepEqual(other && linkKey(other), 'r1--r2');
});

test('OSPF router-ids map back to devices', () => {
  assert.equal(deviceForRouterId('10.255.0.3'), 'r3');
  assert.equal(deviceForRouterId('10.255.9.9'), null);
});

test('adjacency follows the physical chain', () => {
  assert.equal(areAdjacent('r2', 'r3'), true);
  assert.equal(areAdjacent('r1', 'r3'), false);
  assert.equal(areAdjacent('pc1', 'pc2'), false);
});

test('linkBetween is order independent', () => {
  assert.equal(linkBetween('r3', 'r2'), linkBetween('r2', 'r3'));
});

test('breaking the R2-R3 link cuts off everything beyond it', () => {
  const link = linkBetween('r2', 'r3');
  assert.notEqual(link, null);

  const unreachable = predictUnreachable(new Set([linkKey(link!)]), new Set());
  assert.deepEqual(unreachable, ['pc2', 'r3']);
});

test('losing R3 cuts off the same set as losing the R2-R3 link', () => {
  const byDevice = predictUnreachable(new Set(), new Set(['r3']));
  const link = linkBetween('r2', 'r3');
  const byLink = predictUnreachable(new Set([linkKey(link!)]), new Set());

  // This equality is the whole reason ICMP cannot distinguish scenarios 01
  // and 02, and why Layer 0's log evidence is what settles it.
  assert.deepEqual(byDevice, byLink);
});

test('losing a leaf host affects only that host', () => {
  assert.deepEqual(predictUnreachable(new Set(), new Set(['pc2'])), ['pc2']);
});

test('a healthy topology predicts nothing unreachable', () => {
  assert.deepEqual(predictUnreachable(new Set(), new Set()), []);
});

test('reachability is judged from r1, where the host enters the data plane', () => {
  // Host routes point at r1, so losing r1 blinds the monitor to everything.
  const unreachable = predictUnreachable(new Set(), new Set(['r1']));
  assert.deepEqual(unreachable, ['pc1', 'pc2', 'r1', 'r2', 'r3']);
});
