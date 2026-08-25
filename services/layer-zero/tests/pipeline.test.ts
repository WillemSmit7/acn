import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayerZeroPipeline } from '../src/pipeline.js';
import { createLogger } from '../src/logger.js';
import type { AppConfig } from '../src/config/env.js';
import type { LogSourceConfig } from '../src/config/sources.js';
import type { ProcessedLine } from '../src/models/types.js';
import type { LayerZeroRepository } from '../src/firebase/repository.js';

const source: LogSourceConfig = {
  deviceId: 'r2',
  containerName: 'clab-acn-r2',
  logPaths: ['/var/log/frr/zebra.log', '/var/log/frr/ospfd.log'],
  source: 'frr',
};

const config: AppConfig = {
  projectId: 'acn-test',
  emulatorHost: '127.0.0.1:8080',
  dockerBinary: 'docker',
  flushIntervalMs: 500,
  restartDelayMs: 3000,
  logLevel: 'error',
};

/** Captures what would have been written, so no emulator is needed. */
class FakeRepository {
  readonly saved: ProcessedLine[] = [];
  constructor(private readonly failWith?: Error) {}

  async saveProcessedLines(lines: ProcessedLine[]) {
    if (this.failWith !== undefined) throw this.failWith;
    this.saved.push(...lines);
    return {
      logsWritten: lines.length,
      eventsWritten: lines.filter((line) => line.event !== null).length,
    };
  }
}

function build(repository: FakeRepository): LayerZeroPipeline {
  return new LayerZeroPipeline(
    [source],
    config,
    repository as unknown as LayerZeroRepository,
    createLogger('error'),
  );
}

const INTERFACE_DOWN =
  '2026/08/25 19:14:43 ZEBRA: [SBFM4-2P25V] MESSAGE: ZEBRA_INTERFACE_DOWN eth2 vrf default(0)';

test('a recognised line is stored raw and normalized into an event', async () => {
  const repository = new FakeRepository();
  const pipeline = build(repository);

  pipeline.handleLine(source, INTERFACE_DOWN);
  await pipeline.flush();

  assert.equal(repository.saved.length, 1);
  const [line] = repository.saved;
  assert.equal(line?.raw.raw, INTERFACE_DOWN);
  assert.equal(line?.raw.deviceId, 'r2');
  assert.equal(line?.parsed?.daemon, 'ZEBRA');
  assert.equal(line?.event?.eventType, 'interface_down');
});

test('an unparseable line is still stored, with no event', async () => {
  const repository = new FakeRepository();
  const pipeline = build(repository);

  // A parser gap must stay visible and recoverable rather than silently
  // discarding the only record that the device said anything.
  pipeline.handleLine(source, '[33|zebra] sending configuration');
  await pipeline.flush();

  assert.equal(repository.saved.length, 1);
  assert.equal(repository.saved[0]?.parsed, null);
  assert.equal(repository.saved[0]?.event, null);
  assert.equal(repository.saved[0]?.raw.raw, '[33|zebra] sending configuration');
});

test('a parsed line that matches no rule is stored without an event', async () => {
  const repository = new FakeRepository();
  const pipeline = build(repository);

  pipeline.handleLine(
    source,
    '2026/08/25 19:14:43 ZEBRA: [QQWTF-ZKJDD] rib_update: Scheduled VRF (ALL), event RIB_UPDATE_KERNEL',
  );
  await pipeline.flush();

  assert.equal(repository.saved[0]?.parsed?.daemon, 'ZEBRA');
  assert.equal(repository.saved[0]?.event, null);
});

test('a Firestore failure is swallowed - collection must never stop', async () => {
  const repository = new FakeRepository(new Error('emulator unreachable'));
  const pipeline = build(repository);

  pipeline.handleLine(source, INTERFACE_DOWN);

  // Security rule 8: losing the database loses writes, never the service.
  await assert.doesNotReject(() => pipeline.flush());

  // The pipeline stays usable afterwards.
  pipeline.handleLine(source, INTERFACE_DOWN);
  assert.equal(pipeline.stats().linesSeen, 2);
});

test('a failed flush does not re-queue its lines indefinitely', async () => {
  const repository = new FakeRepository(new Error('emulator unreachable'));
  const pipeline = build(repository);

  pipeline.handleLine(source, INTERFACE_DOWN);
  await pipeline.flush();

  // Retrying forever would grow without bound for as long as Firestore stayed
  // down, so the batch is dropped rather than replayed.
  await pipeline.flush();
  assert.equal(pipeline.stats().linesSeen, 1);
});

test('flushing with nothing buffered is a no-op', async () => {
  const repository = new FakeRepository();
  const pipeline = build(repository);

  await pipeline.flush();
  assert.equal(repository.saved.length, 0);
});

test('counters distinguish lines collected from events emitted', async () => {
  const repository = new FakeRepository();
  const pipeline = build(repository);

  pipeline.handleLine(source, INTERFACE_DOWN);
  pipeline.handleLine(source, 'Waiting for children to finish applying config...');
  await pipeline.flush();

  assert.deepEqual(pipeline.stats(), { linesSeen: 2, eventsEmitted: 1 });
});
