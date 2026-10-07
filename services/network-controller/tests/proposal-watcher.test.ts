import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalFromRun } from '../src/proposal-watcher.js';

test('completed run projection contains only the typed remediation proposal', () => {
  assert.deepEqual(proposalFromRun({
    runId: 'RUN-001',
    incidentId: 'INC-001',
    conclusion: {
      summary: 'ignored',
      remediationProposal: {
        tool: 'enable_interface',
        rationale: 'Interface is administratively down.',
        citedEvidenceIds: ['evt-001'],
        command: 'must not pass through',
      },
    },
    prompt: { secret: 'must not pass through' },
  }), {
    incidentId: 'INC-001',
    agentRunId: 'RUN-001',
    tool: 'enable_interface',
    rationale: 'Interface is administratively down.',
    citedEvidenceIds: ['evt-001'],
  });
});

test('malformed run is ignored without creating a proposal', () => {
  assert.equal(proposalFromRun({ runId: 'RUN-001', conclusion: {} }), null);
});
