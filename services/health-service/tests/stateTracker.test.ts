import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateTracker, transitionToEvent } from '../src/checks/stateTracker.js';
import type { HealthCheckResult } from '../src/models/types.js';

function result(deviceId: string, status: 'healthy' | 'down'): HealthCheckResult {
  return {
    deviceId,
    checkType: 'icmp',
    status,
    latencyMs: status === 'healthy' ? 1.5 : null,
    target: '10.255.0.3',
  };
}

test('the first observation seeds a baseline without emitting an event', () => {
  const tracker = new StateTracker();
  assert.equal(tracker.observe(result('r3', 'healthy')), null);
  assert.equal(tracker.statusOf('r3'), 'healthy');
});

test('a device that is down on the very first check emits no event', () => {
  const tracker = new StateTracker();
  assert.equal(tracker.observe(result('r3', 'down')), null);
});

test('healthy -> healthy produces no transition', () => {
  const tracker = new StateTracker();
  tracker.observe(result('r3', 'healthy'));
  assert.equal(tracker.observe(result('r3', 'healthy')), null);
});

test('healthy -> down produces a device_unreachable event', () => {
  const tracker = new StateTracker();
  tracker.observe(result('r3', 'healthy'));

  const transition = tracker.observe(result('r3', 'down'));
  assert.deepEqual(transition, { deviceId: 'r3', from: 'healthy', to: 'down' });

  const event = transitionToEvent(transition!);
  assert.equal(event?.eventType, 'device_unreachable');
  assert.equal(event?.severity, 'critical');
  assert.equal(event?.deviceId, 'r3');
});

test('down -> healthy produces a device_recovered event', () => {
  const tracker = new StateTracker();
  tracker.observe(result('r3', 'healthy'));
  tracker.observe(result('r3', 'down'));

  const transition = tracker.observe(result('r3', 'healthy'));
  assert.deepEqual(transition, { deviceId: 'r3', from: 'down', to: 'healthy' });

  const event = transitionToEvent(transition!);
  assert.equal(event?.eventType, 'device_recovered');
  assert.equal(event?.severity, 'info');
});

test('a full healthy -> down -> healthy cycle emits exactly two events', () => {
  const tracker = new StateTracker();
  const rounds: Array<'healthy' | 'down'> = ['healthy', 'healthy', 'down', 'down', 'healthy'];

  const events = rounds
    .flatMap((status) => tracker.observeAll([result('r3', status)]))
    .map(transitionToEvent);

  assert.deepEqual(
    events.map((event) => event?.eventType),
    ['device_unreachable', 'device_recovered'],
  );
});

test('devices are tracked independently of each other', () => {
  const tracker = new StateTracker();
  tracker.observeAll([result('r2', 'healthy'), result('r3', 'healthy')]);

  const transitions = tracker.observeAll([result('r2', 'healthy'), result('r3', 'down')]);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.deviceId, 'r3');
});
