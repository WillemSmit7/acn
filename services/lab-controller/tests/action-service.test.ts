import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionBusyError, LabActionService } from '../src/action-service.js';
import type { ActionRepositoryPort, LabAction, ScenarioRunnerPort } from '../src/types.js';

class FakeRepository implements ActionRepositoryPort {
  created: LabAction[] = [];
  finished: LabAction[] = [];
  async create(action: LabAction): Promise<void> { this.created.push(copy(action)); }
  async updateOutput(): Promise<void> {}
  async finish(action: LabAction): Promise<void> { this.finished.push(copy(action)); }
}

test('runs only a whitelisted scenario and records its streamed output', async () => {
  const repository = new FakeRepository();
  const runner: ScenarioRunnerPort = {
    async run(scenario, onLine) {
      assert.match(scenario.scriptPath, /01-link-failure\.sh$/);
      await onLine('interface eth2 down');
      return 0;
    },
    stop() {},
  };
  const service = new LabActionService(repository, runner, () => undefined);

  const action = await service.trigger('link-failure');
  await service.stop();

  assert.equal(action.status, 'completed');
  assert.deepEqual(action.output, ['interface eth2 down']);
  assert.equal(repository.created.length, 1);
  assert.equal(repository.finished[0]?.status, 'completed');
});

test('rejects a second action while one is running', async () => {
  let release: (() => void) | undefined;
  const runner: ScenarioRunnerPort = {
    run: () => new Promise<number>((resolve) => { release = () => resolve(0); }),
    stop() { release?.(); },
  };
  const service = new LabActionService(new FakeRepository(), runner, () => undefined);

  await service.trigger('router-failure');
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
});

function copy(action: LabAction): LabAction {
  return { ...action, output: [...action.output] };
}
