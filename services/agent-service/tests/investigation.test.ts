import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, PROMPT_VERSION } from '../src/investigation/prompt.js';
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

test('prompt defines confidence using corroboration, alternatives and evidence gaps', () => {
  const prompt = buildPrompt(linkIncident, linkEvidence);
  assert.equal(prompt.version, 'gpt-investigator-v4-evidence-confidence');
  assert.equal(prompt.version, PROMPT_VERSION);
  assert.match(prompt.developer, /high confidence only when direct evidence.*independent observations/);
  assert.match(prompt.developer, /raw log it was derived from are one observation/);
  assert.match(prompt.developer, /medium confidence.*corroboration is incomplete/);
  assert.match(prompt.developer, /low confidence.*sparse, indirect, conflicting/);
  assert.match(prompt.developer, /not a calibrated probability/);
  assert.match(prompt.developer, /reasoning.*IDs, timestamps and sources/);
  assert.match(prompt.developer, /gaps, contradictions and plausible alternative explanations/);
  // Confidence instructions must not expose the hidden lab answer to the model.
  const input = JSON.parse(prompt.input) as Record<string, unknown>;
  assert.deepEqual(Object.keys(input), [
    'task', 'guardedRepairIntents', 'incident', 'neutralObservations', 'rawDeviceLogs',
  ]);
  assert.deepEqual(input['incident'], {
    incidentId: linkIncident.incidentId,
    status: linkIncident.status,
    severity: linkIncident.severity,
    affectedDevices: linkIncident.affectedDevices,
  });
});

test('prompt requests a manager summary without unsupported outcomes or benefit claims', () => {
  const prompt = buildPrompt(linkIncident, linkEvidence);
  assert.match(prompt.developer, /summary as a short plain-language incident summary for a manager/);
  assert.match(prompt.developer, /preserving uncertainty/);
  assert.match(prompt.developer, /Do not invent recovery, approval, elapsed time, business impact or time saved/);
  assert.match(prompt.developer, /proposed repair is not an executed repair/);
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
