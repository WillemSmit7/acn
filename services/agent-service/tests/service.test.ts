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

test('one blind diagnosis is claimed once and scored only after model completion', async () => {
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
  assert.deepEqual(repository.completions[0]?.groundTruth, {
    rootCauseType: 'interface_misconfiguration', rootCauseDevices: ['r2', 'r3'],
    expectedRemediationTool: 'enable_interface',
  });
  assert.equal(repository.completions[0]?.evaluation?.overallMatch, true);
  assert.doesNotMatch(repository.analyzing[0]?.prompt.input ?? '', /deterministicBaseline/);
  assert.doesNotMatch(repository.analyzing[0]?.prompt.input ?? '', /interface_misconfiguration/);
  assert.equal(repository.failures.length, 0);
});

test('unsettled incidents do not claim or invoke an investigation', async () => {
  const repository = new FakeRepository();
  let invocations = 0;
  const service = new AgentService(config, repository, {
    investigate: async () => { invocations += 1; return modelResult(); },
  }, quietLogger());

  service.start();
  repository.emit({ ...linkIncident, investigationReady: false });
  await service.stop();

  assert.equal(repository.claims.length, 0);
  assert.equal(invocations, 0);
});

test('incident and evidence are reloaded after the run is claimed', async () => {
  const repository = new FakeRepository();
  const service = new AgentService(config, repository, {
    investigate: async () => modelResult(),
  }, quietLogger());
  const staleCallback = { ...linkIncident, eventIds: linkIncident.eventIds.slice(0, 4) };

  service.start();
  repository.emit(staleCallback);
  await service.stop();

  assert.ok(repository.incidentLoads >= 2);
  assert.deepEqual(repository.evidenceLoads[0], linkIncident.eventIds);
});

test('evidence that changes while loading is reloaded before GPT invocation', async () => {
  const initial = { ...linkIncident, eventIds: linkIncident.eventIds.slice(0, 4) };
  const repository = new FakeRepository(undefined, initial);
  repository.afterFirstEvidenceLoad = () => repository.setCurrent(linkIncident);
  const service = new AgentService(config, repository, {
    investigate: async () => modelResult(),
  }, quietLogger());

  service.start();
  repository.emit(initial);
  await service.stop();

  assert.equal(repository.evidenceLoads.length, 2);
  assert.deepEqual(repository.evidenceLoads[1], linkIncident.eventIds);
  assert.equal(repository.completions.length, 1);
});

test('a new fault generation supersedes a stale callback and receives its own run', async () => {
  const repository = new FakeRepository();
  const service = new AgentService(config, repository, {
    investigate: async () => modelResult(),
  }, quietLogger());
  const next = {
    ...linkIncident,
    eventIds: [...linkIncident.eventIds, 'evt-repeat'],
    investigationRevision: 2,
    settledAt: '2026-08-25T19:16:18.000Z',
  };

  service.start();
  repository.emit(linkIncident);
  repository.setCurrent(next);
  repository.emit(next);
  await service.stop();

  assert.equal(repository.claims.length, 1);
  assert.equal(repository.claims[0]?.incident.investigationRevision, 2);
  assert.equal(repository.completions.length, 1);
});

test('duplicate callbacks across concurrent service instances create one run', async () => {
  const repository = new FakeRepository();
  const client: InvestigatorClient = { investigate: async () => modelResult() };
  const first = new AgentService(config, repository, client, quietLogger());
  const second = new AgentService(config, repository, client, quietLogger());

  first.start();
  second.start();
  repository.emit(linkIncident);
  repository.emit(linkIncident);
  await Promise.all([first.stop(), second.stop()]);

  assert.equal(repository.claims.length, 1);
  assert.equal(repository.completions.length, 1);
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

test('a diagnosis without controller ground truth completes as unscored', async () => {
  const repository = new FakeRepository(null);
  const client: InvestigatorClient = { investigate: async () => modelResult() };
  const service = new AgentService(config, repository, client, quietLogger());

  service.start();
  repository.emit(linkIncident);
  await service.stop();

  assert.equal(repository.completions[0]?.groundTruth, null);
  assert.equal(repository.completions[0]?.evaluation, null);
});

class FakeRepository implements AgentRepositoryPort {
  readonly claims: RunClaim[] = [];
  readonly analyzing: { runId: string; prompt: PromptRecord }[] = [];
  readonly completions: RunCompletion[] = [];
  readonly failures: { runId: string; error: unknown }[] = [];
  readonly evidenceLoads: string[][] = [];
  incidentLoads = 0;
  afterFirstEvidenceLoad: (() => void) | undefined;
  private readonly listeners = new Set<(incidents: InvestigableIncident[]) => void>();
  private readonly runIds = new Set<string>();
  private current: InvestigableIncident;

  constructor(private readonly truth: {
    rootCauseType: 'interface_misconfiguration'; rootCauseDevices: string[];
    expectedRemediationTool: 'enable_interface';
  } | null | undefined = {
    rootCauseType: 'interface_misconfiguration', rootCauseDevices: ['r2', 'r3'],
    expectedRemediationTool: 'enable_interface',
  }, current: InvestigableIncident = linkIncident) {
    this.current = current;
  }

  watchIncidents(onIncidents: (incidents: InvestigableIncident[]) => void): () => void {
    this.listeners.add(onIncidents);
    return () => { this.listeners.delete(onIncidents); };
  }

  emit(incident: InvestigableIncident): void {
    for (const listener of this.listeners) listener([incident]);
  }

  setCurrent(incident: InvestigableIncident): void {
    this.current = incident;
  }

  async loadIncident(_incidentId: string): Promise<InvestigableIncident | null> {
    this.incidentLoads += 1;
    return this.current.investigationReady ? this.current : null;
  }

  async claimRun(claim: RunClaim): Promise<boolean> {
    if (!this.current.investigationReady ||
        this.current.investigationRevision !== claim.incident.investigationRevision) return false;
    if (this.runIds.has(claim.runId)) return false;
    this.runIds.add(claim.runId);
    this.claims.push(claim);
    return true;
  }

  async loadEvidence(eventIds: string[]): Promise<EvidenceBundle> {
    this.evidenceLoads.push([...eventIds]);
    if (this.evidenceLoads.length === 1) this.afterFirstEvidenceLoad?.();
    return linkEvidence;
  }

  async loadGroundTruth(): Promise<{
    rootCauseType: 'interface_misconfiguration'; rootCauseDevices: string[];
    expectedRemediationTool: 'enable_interface';
  } | null> {
    return this.truth ?? null;
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
