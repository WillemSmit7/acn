import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/investigation/prompt.js';
import { diagnosisVersion, runIdFor } from '../src/investigation/version.js';
import { evaluate, validateCitations } from '../src/service.js';
import { agreeingConclusion, linkEvidence, linkIncident } from './fixtures.js';

test('diagnosis version stays stable within one settled evidence generation', () => {
  const first = diagnosisVersion(
    linkIncident.incidentId,
    linkIncident.investigationRevision,
    'prompt-v3',
  );
  const recovered = {
    ...linkIncident,
    status: 'open' as const,
    eventIds: [...linkIncident.eventIds, 'evt-recovery'],
  };
  assert.equal(
    diagnosisVersion(recovered.incidentId, recovered.investigationRevision, 'prompt-v3'),
    first,
  );
  assert.match(runIdFor(linkIncident, first), /^RUN-INC-001-[A-F0-9]{12}$/);
});

test('a newly settled evidence generation receives a distinct run identity', () => {
  assert.notEqual(
    diagnosisVersion(linkIncident.incidentId, 2, 'prompt-v3'),
    diagnosisVersion(linkIncident.incidentId, 1, 'prompt-v3'),
  );
});

test('a changed prompt contract receives a new blind-investigation version', () => {
  assert.notEqual(
    diagnosisVersion(linkIncident.incidentId, linkIncident.investigationRevision, 'prompt-v4'),
    diagnosisVersion(linkIncident.incidentId, linkIncident.investigationRevision, 'prompt-v3'),
  );
});

test('prompt contains neutral evidence but no deterministic answer or cause labels', () => {
  const prompt = buildPrompt(linkIncident, linkEvidence);
  assert.match(prompt.developer, /strictly read-only/i);
  assert.match(prompt.input, /evt-r2-ospf/);
  assert.match(prompt.input, /log-r3-ospf/);
  assert.match(prompt.input, /Full -> Deleted \(KillNbr\)/);
  assert.doesNotMatch(prompt.input, /deterministicBaseline/);
  assert.doesNotMatch(prompt.input, /R2 <-> R3 link failure/);
  assert.doesNotMatch(prompt.input, /interface_misconfiguration/);
  assert.doesNotMatch(prompt.input, /ospf_neighbor_down/);
  assert.doesNotMatch(prompt.input, /r2 eth2 down/);
  assert.match(prompt.input, /protocol_adjacency_state/);
  assert.match(prompt.input, /"observedState": "unreachable"/);
});

test('prompt still requires explicit interface-down or administrative-state evidence', () => {
  const prompt = buildPrompt(linkIncident, linkEvidence);
  assert.match(prompt.developer, /interface-down event or explicit admin-state observation is required/i);
  assert.match(prompt.developer, /escalate_no_safe_action when evidence is insufficient/i);
});

test('post-response evaluation scores type and device set independently', () => {
  const truth = {
    rootCauseType: 'interface_misconfiguration', rootCauseDevices: ['r2', 'r3'],
    expectedRemediationTool: 'enable_interface',
  };
  assert.deepEqual(evaluate(truth, agreeingConclusion), {
    typeMatch: true, devicesMatch: true, remediationMatch: true, overallMatch: true,
  });
  assert.deepEqual(
    evaluate(truth, { ...agreeingConclusion, rootCauseType: 'routing_service_failure' }),
    { typeMatch: false, devicesMatch: true, remediationMatch: true, overallMatch: false },
  );
  assert.deepEqual(
    evaluate(truth, { ...agreeingConclusion, rootCauseDevices: ['r2'] }),
    { typeMatch: true, devicesMatch: false, remediationMatch: true, overallMatch: false },
  );
  assert.equal(evaluate(truth, {
    ...agreeingConclusion,
    remediationProposal: { ...agreeingConclusion.remediationProposal, tool: 'restore_ospf_cost' },
  }).remediationMatch, false);
});

test('citations must resolve to supplied evidence', () => {
  const eventIds = linkEvidence.events.map((event) => event.id);
  const logIds = linkEvidence.logs.map((log) => log.id);
  assert.doesNotThrow(() => validateCitations(agreeingConclusion, eventIds, logIds));
  assert.throws(
    () => validateCitations({ ...agreeingConclusion, citedEventIds: ['invented'] }, eventIds, logIds),
    /unknown event id/,
  );
  assert.throws(
    () => validateCitations({ ...agreeingConclusion, citedLogIds: [] }, eventIds, logIds),
    /cited no raw logs/,
  );
});
