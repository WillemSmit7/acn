import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessScenarioRunner } from '../src/process-runner.js';
import type { ScenarioDefinition } from '../src/scenarios.js';

test('terminates a timed-out scenario process group', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'acn-scenario-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const scriptPath = join(directory, 'scenario.sh');
  // The shell owns a sleeping child: the runner must terminate the entire group,
  // or a timed-out scenario could keep running after the UI has unlocked.
  await writeFile(scriptPath, '#!/bin/sh\necho started\nsleep 30\n');
  await chmod(scriptPath, 0o755);

  const scenario: ScenarioDefinition = {
    id: 'restore',
    label: 'test timeout',
    description: 'test timeout cleanup',
    tone: 'restore',
    scriptPath,
  };
  const output: string[] = [];
  const runner = new ProcessScenarioRunner(100, 100);
  const startedAt = Date.now();

  const exitCode = await runner.run(scenario, async (line) => {
    output.push(line);
  });

  assert.equal(exitCode, 124);
  assert.deepEqual(output, ['started']);
  assert.ok(Date.now() - startedAt < 5_000, 'timed-out scenario should release promptly');
});
