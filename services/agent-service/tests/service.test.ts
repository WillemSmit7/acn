import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../src/config/env.js';
import type { Logger } from '../src/logger.js';
import type {
  AgentRepositoryPort,
  EvidenceBundle,
  InvestigableIncident,
  InvestigatorClient,
  PromptRecord,
  RunClaim,
  RunCompletion,
} from '../src/models/types.js';
import { AgentService } from '../src/service.js';
import { linkEvidence, linkIncident, modelResult } from './fixtures.js';

const config: AppConfig = {
  projectId: 'acn-local',
  emulatorHost: '127.0.0.1:8080',
  openAIApiKey: 'test-key',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  timeoutMs: 5_000,
  maxOutputTokens: 4_096,
  logLevel: 'error',
};

test('one diagnosis is claimed once and completed with evidence and agreement', async () => {
  const repository = new FakeRepository();
  const client: InvestigatorClient = { investigate: async () => modelResult() };
  const service = new AgentService(config, repository, client, quietLogger());

  service.start();
  repository.emit(linkIncident);
  repository.emit(linkIncident);
  await service.stop();

  assert.equal(repository.claims.length, 1);
  assert.equal(repository.analyzing.length, 1);
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.completions[0]?.agreement, 'agree');
  assert.equal(repository.failures.length, 0);
});

test('model failure is recorded and does not reject service shutdown', async () => {
  const repository = new FakeRepository();
  const client: InvestigatorClient = {
    investigate: async () => { throw new Error('rate limited'); },
  };
  const service = new AgentService(config, repository, client, quietLogger());

  service.start();
  repository.emit(linkIncident);
  await assert.doesNotReject(() => service.stop());

  assert.equal(repository.failures.length, 1);
  assert.match(String(repository.failures[0]?.error), /rate limited/);
  assert.equal(repository.completions.length, 0);
});

class FakeRepository implements AgentRepositoryPort {
  readonly claims: RunClaim[] = [];
  readonly analyzing: { runId: string; prompt: PromptRecord }[] = [];
  readonly completions: RunCompletion[] = [];
  readonly failures: { runId: string; error: unknown }[] = [];
  private listener: ((incidents: InvestigableIncident[]) => void) | undefined;
  private readonly runIds = new Set<string>();

  watchIncidents(onIncidents: (incidents: InvestigableIncident[]) => void): () => void {
    this.listener = onIncidents;
    return () => { this.listener = undefined; };
  }

  emit(incident: InvestigableIncident): void {
    this.listener?.([incident]);
  }

  async claimRun(claim: RunClaim): Promise<boolean> {
    if (this.runIds.has(claim.runId)) return false;
    this.runIds.add(claim.runId);
    this.claims.push(claim);
    return true;
  }

  async loadEvidence(_eventIds: string[]): Promise<EvidenceBundle> {
    return linkEvidence;
  }

  async markAnalyzing(runId: string, _evidence: EvidenceBundle, prompt: PromptRecord): Promise<void> {
    this.analyzing.push({ runId, prompt });
  }

  async completeRun(_runId: string, completion: RunCompletion): Promise<void> {
    this.completions.push(completion);
  }

  async failRun(runId: string, error: unknown, _latencyMs: number): Promise<void> {
    this.failures.push({ runId, error });
  }
}

function quietLogger(): Logger {
  const noop = (_message: string): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, line: noop };
}
