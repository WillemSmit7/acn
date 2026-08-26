import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/investigation/prompt.js';
import { diagnosisVersion, runIdFor } from '../src/investigation/version.js';
import { agrees, validateCitations } from '../src/service.js';
import { agreeingConclusion, linkEvidence, linkIncident } from './fixtures.js';

test('diagnosis version stays stable when lifecycle fields and event history change', () => {
  const first = diagnosisVersion(linkIncident.rootCause);
  const recovered = {
    ...linkIncident,
    status: 'open' as const,
    eventIds: [...linkIncident.eventIds, 'evt-recovery'],
  };
  assert.equal(diagnosisVersion(recovered.rootCause), first);
  assert.match(runIdFor(linkIncident, first), /^RUN-INC-001-[A-F0-9]{12}$/);
});

test('a changed deterministic diagnosis receives a new version', () => {
  const changed = { ...linkIncident.rootCause, type: 'unknown' as const };
  assert.notEqual(diagnosisVersion(changed), diagnosisVersion(linkIncident.rootCause));
});

test('prompt contains the baseline, exact event ids and verbatim raw logs', () => {
  const prompt = buildPrompt(linkIncident, linkEvidence);
  assert.match(prompt.developer, /strictly read-only/i);
  assert.match(prompt.input, /evt-r2-ospf/);
  assert.match(prompt.input, /log-r3-ospf/);
  assert.match(prompt.input, /Full -> Deleted \(KillNbr\)/);
  assert.match(prompt.input, /R2 <-> R3 link failure/);
});

test('agreement is based on root-cause type and device set, not wording or order', () => {
  assert.equal(agrees(linkIncident, agreeingConclusion), true);
  assert.equal(
    agrees(linkIncident, { ...agreeingConclusion, rootCauseType: 'device_failure' }),
    false,
  );
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
