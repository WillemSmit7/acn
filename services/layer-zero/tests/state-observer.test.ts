import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';
import {
  stateProbeInternals,
  type RouterStateSnapshot,
  type StateProbePort,
} from '../src/observer/dockerStateProbe.js';
import { AutonomousStateObserver } from '../src/observer/stateObserver.js';
import type { StateObservation } from '../src/models/types.js';

class FakeProbe implements StateProbePort {
  snapshots: RouterStateSnapshot[] = [];
  failure: Error | null = null;

  async inspect(): Promise<RouterStateSnapshot[]> {
    if (this.failure !== null) throw this.failure;
    return this.snapshots;
  }
}

function r2(facts: RouterStateSnapshot['facts']): RouterStateSnapshot {
  return {
    deviceId: 'r2',
    observedAt: new Date('2026-08-26T20:00:00.000Z'),
    raw: 'show running-config output',
    facts: { ospfCost: 10, passiveEth2: false, eth2AdminDown: false, ...facts },
  };
}

function r3(facts: RouterStateSnapshot['facts']): RouterStateSnapshot {
  return {
    deviceId: 'r3',
    observedAt: new Date('2026-08-26T20:00:00.000Z'),
    raw: 'ospfd=running\ncpu.max=max 100000',
    facts: { ospfdProcessState: 'running', cpuQuotaPercent: 100, ...facts },
  };
}

function build(probe: FakeProbe, emitted: StateObservation[]): AutonomousStateObserver {
  return new AutonomousStateObserver(probe, 60_000, (event) => emitted.push(event), createLogger('error'));
}

test('healthy first inspection seeds a quiet baseline', async () => {
  const probe = new FakeProbe();
  const emitted: StateObservation[] = [];
  probe.snapshots = [r2({}), r3({})];

  await build(probe, emitted).poll();

  assert.deepEqual(emitted, []);
});

test('a fault already present at startup is detected without a scenario marker', async () => {
  const probe = new FakeProbe();
  const emitted: StateObservation[] = [];
  probe.snapshots = [r2({ ospfCost: 65535 })];

  await build(probe, emitted).poll();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.eventType, 'configuration_drift');
  assert.equal(emitted[0]?.attributes['observed'], '65535');
  assert.equal(emitted[0]?.raw, 'show running-config output');
});

test('unchanged faults are deduplicated and recovery is emitted once', async () => {
  const probe = new FakeProbe();
  const emitted: StateObservation[] = [];
  const observer = build(probe, emitted);
  probe.snapshots = [r2({ passiveEth2: true })];

  await observer.poll();
  await observer.poll();
  probe.snapshots = [r2({ passiveEth2: false })];
  await observer.poll();
  await observer.poll();

  assert.deepEqual(emitted.map((event) => event.eventType), [
    'routing_session_down',
    'routing_session_up',
  ]);
});

test('interface, daemon, and resource conditions are distinguished', async () => {
  const probe = new FakeProbe();
  const emitted: StateObservation[] = [];
  probe.snapshots = [
    r2({ eth2AdminDown: true }),
    r3({ ospfdProcessState: 'missing' }),
  ];
  const observer = build(probe, emitted);
  await observer.poll();

  probe.snapshots = [
    r2({ eth2AdminDown: true }),
    r3({ ospfdProcessState: 'stopped', cpuQuotaPercent: 10 }),
  ];
  await observer.poll();

  assert.deepEqual(emitted.map((event) => event.eventType), [
    'interface_admin_down',
    'routing_service_down',
    'routing_service_up',
    'resource_exhaustion',
  ]);
});

test('a failed inspection does not manufacture recovery events', async () => {
  const probe = new FakeProbe();
  const emitted: StateObservation[] = [];
  const observer = build(probe, emitted);
  probe.snapshots = [r2({ ospfCost: 65535 })];
  await observer.poll();
  probe.failure = new Error('router unavailable');

  await assert.doesNotReject(() => observer.poll());
  assert.deepEqual(emitted.map((event) => event.eventType), ['configuration_drift']);
});

test('an in-flight inspection cannot emit after shutdown', async () => {
  const emitted: StateObservation[] = [];
  let release: ((snapshots: RouterStateSnapshot[]) => void) | undefined;
  const probe: StateProbePort = {
    inspect: () => new Promise((resolve) => { release = resolve; }),
  };
  const observer = new AutonomousStateObserver(
    probe,
    60_000,
    (event) => emitted.push(event),
    createLogger('error'),
  );

  const polling = observer.poll();
  observer.stop();
  release?.([r2({ ospfCost: 65535 })]);
  await polling;

  assert.deepEqual(emitted, []);
});

test('probe helpers parse FRR sections and cgroup quotas', () => {
  const config = [
    'interface eth2',
    ' description to-r3',
    ' ip ospf cost 65535',
    'exit',
    'router ospf',
    ' passive-interface eth2',
    'exit',
  ].join('\n');

  assert.match(stateProbeInternals.configSection(config, 'interface eth2'), /cost 65535/);
  assert.doesNotMatch(stateProbeInternals.configSection(config, 'interface eth2'), /passive/);
  assert.equal(stateProbeInternals.quotaPercent('10000 100000'), 10);
  assert.equal(stateProbeInternals.quotaPercent('max 100000'), 100);
  assert.equal(stateProbeInternals.quotaPercent('unknown'), null);
});
