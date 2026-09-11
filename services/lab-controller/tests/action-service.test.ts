import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionBusyError, LabActionService } from '../src/action-service.js';
import { SCENARIOS, type LabGroundTruth } from '../src/scenarios.js';
import type { ActionRepositoryPort, LabAction, ScenarioRunnerPort } from '../src/types.js';

class FakeRepository implements ActionRepositoryPort {
  created: LabAction[] = [];
  finished: LabAction[] = [];
  truths: (LabGroundTruth | undefined)[] = [];
  async create(action: LabAction): Promise<void> { this.created.push(copy(action)); }
  async updateOutput(): Promise<void> {}
  async finish(action: LabAction, truth?: LabGroundTruth): Promise<void> {
    this.finished.push(copy(action));
    this.truths.push(truth);
  }
}

test('exposes exactly the five ISP failures plus restore', () => {
  assert.deepEqual(Object.keys(SCENARIOS), [
    'configuration-drift',
    'routing-session-failure',
    'interface-disabled',
    'routing-service-crash',
    'resource-exhaustion',
    'restore',
  ]);
  assert.ok(!Object.keys(SCENARIOS).includes('router-failure'));
});

test('runs only a whitelisted scenario and records its streamed output', async () => {
  const repository = new FakeRepository();
  const runner: ScenarioRunnerPort = {
    async run(scenario, onLine) {
      assert.match(scenario.scriptPath, /01-configuration-drift\.sh$/);
      await onLine('configuration drift detected');
      return 0;
    },
    stop() {},
  };
  const service = new LabActionService(repository, runner, () => undefined);

  const action = await service.trigger('configuration-drift');
  await service.stop();

  assert.equal(action.status, 'completed');
  assert.deepEqual(action.output, ['configuration drift detected']);
  assert.equal(repository.created.length, 1);
  assert.equal(repository.finished[0]?.status, 'completed');
  assert.deepEqual(repository.truths[0], {
    rootCauseType: 'configuration_drift', rootCauseDevices: ['r2'],
    expectedRemediationTool: 'restore_ospf_cost',
  });
});

test('rejects a second action while one is running', async () => {
  let release: (() => void) | undefined;
  const runner: ScenarioRunnerPort = {
    run: () => new Promise<number>((resolve) => { release = () => resolve(0); }),
    stop() { release?.(); },
  };
  const service = new LabActionService(new FakeRepository(), runner, () => undefined);

  await service.trigger('routing-service-crash');
  await assert.rejects(() => service.trigger('restore'), ActionBusyError);
  release?.();
  await service.stop();
});

test('records a failed scenario without throwing from the background task', async () => {
  const repository = new FakeRepository();
  const runner: ScenarioRunnerPort = {
    async run() { return 2; },
    stop() {},
  };
  const service = new LabActionService(repository, runner, () => undefined);

  const action = await service.trigger('restore');
  await service.stop();

  assert.equal(action.status, 'failed');
  assert.equal(action.error, 'Scenario exited with code 2');
  assert.equal(repository.finished[0]?.exitCode, 2);
  assert.equal(repository.truths[0], undefined);
});

test('successful restore does not create ground truth', async () => {
  const repository = new FakeRepository();
  const runner: ScenarioRunnerPort = { async run() { return 0; }, stop() {} };
  const service = new LabActionService(repository, runner, () => undefined);

  await service.trigger('restore');
  await service.stop();

  assert.equal(repository.truths[0], undefined);
});

function copy(action: LabAction): LabAction {
  return { ...action, output: [...action.output] };
}
