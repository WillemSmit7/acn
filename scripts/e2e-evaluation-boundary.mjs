#!/usr/bin/env node
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ActionRepository } from '../services/lab-controller/dist/repository.js';
import { AgentRepository } from '../services/agent-service/dist/firebase/repository.js';
import { evaluate } from '../services/agent-service/dist/service.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set - refusing to query production.');
  process.exit(2);
}

const projectId = `acn-evaluation-boundary-${Date.now()}`;
const app = initializeApp({ projectId }, projectId);
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });
const actionRepository = new ActionRepository(db);
const agentRepository = new AgentRepository(db, {
  debug() {}, info() {}, warn() {}, error() {}, line() {},
});

const action = {
  id: 'LAB-BLIND-001',
  scenario: 'interface-disabled',
  label: 'Disable test interface',
  status: 'completed',
  output: ['scenario completed'],
  requestedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  exitCode: 0,
  error: null,
};

await actionRepository.create(action);
await actionRepository.finish(action, {
  rootCauseType: 'interface_misconfiguration',
  rootCauseDevices: ['r2'],
});

const claim = {
  runId: 'RUN-BLIND-001',
  diagnosisVersion: 'blind-v3',
  incident: {
    incidentId: 'INC-BLIND-001',
    status: 'open',
    severity: 'warning',
    startedAt: new Date(Date.now() + 1_000).toISOString(),
    symptoms: ['must not enter prompt'],
    affectedDevices: ['r2'],
    eventIds: ['EVT-BLIND-001'],
  },
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  promptVersion: 'gpt-investigator-v3-neutral-evidence',
};
const staleClaim = {
  ...claim,
  runId: 'RUN-OLD-INCIDENT',
  incident: {
    ...claim.incident,
    incidentId: 'INC-OLD-001',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  },
};
assert.equal(await agentRepository.claimRun(staleClaim), true);
const staleRun = (await db.collection('agentRuns').doc(staleClaim.runId).get()).data();
assert.equal(staleRun?.['labEvaluationId'], null);

assert.equal(await agentRepository.claimRun(claim), true);
assert.equal(await agentRepository.claimRun(claim), false);

const active = (await db.collection('agentRuns').doc(claim.runId).get()).data();
assert.equal(active?.['labGroundTruth'], undefined);
assert.equal(active?.['evaluation'], undefined);
assert.equal(active?.['deterministicRootCause'], undefined);
assert.equal(typeof active?.['labEvaluationId'], 'string');

const truth = await agentRepository.loadGroundTruth(claim.runId);
assert.deepEqual(truth, {
  rootCauseType: 'interface_misconfiguration',
  rootCauseDevices: ['r2'],
});
const conclusion = {
  rootCauseType: 'interface_misconfiguration',
  rootCauseDevices: ['r2'],
  summary: 'R2 interface configuration caused the incident',
  confidence: 'high',
  reasoning: ['The observed administrative state differs from intent.'],
  citedEventIds: ['EVT-BLIND-001'],
  citedLogIds: ['LOG-BLIND-001'],
};
const score = evaluate(truth, conclusion);
await agentRepository.completeRun(claim.runId, {
  responseId: 'resp_test',
  responseModel: 'gpt-5.6-luna',
  conclusion,
  usage: {
    inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputTokens: 10, reasoningTokens: 2, totalTokens: 20,
  },
  latencyMs: 10,
  estimatedCostUsd: 0.00001,
  groundTruth: truth,
  evaluation: score,
});

const completed = (await db.collection('agentRuns').doc(claim.runId).get()).data();
assert.deepEqual(completed?.['labGroundTruth'], truth);
assert.deepEqual(completed?.['evaluation'], {
  typeMatch: true, devicesMatch: true, overallMatch: true,
});
assert.equal(completed?.['agreement'], 'agree');

await deleteApp(app);
console.log('PASS hidden ground truth is atomically claimed and revealed only after GPT completion');
