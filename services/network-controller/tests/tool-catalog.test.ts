import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProposal, TOOL_CATALOG } from '../src/tool-catalog.js';

const valid = {
  incidentId: 'INC-001', agentRunId: 'RUN-001', tool: 'enable_interface',
  rationale: 'The observed administrative state is down.', citedEvidenceIds: ['evt-001'],
};

test('catalog exposes only fixed repair intents and no arbitrary command tool', () => {
  assert.deepEqual(Object.keys(TOOL_CATALOG), [
    'restore_ospf_cost', 'restore_ospf_adjacency', 'enable_interface',
    'restart_routing_service', 'restore_resource_profile', 'escalate_no_safe_action',
  ]);
  assert.ok(!Object.keys(TOOL_CATALOG).includes('run_command'));
});

test('valid proposal contains no caller-controlled target or command', () => {
  assert.deepEqual(parseProposal(valid), valid);
});

for (const [name, proposal] of [
  ['unknown tool', { ...valid, tool: 'run_command' }],
  ['shell field', { ...valid, command: 'docker exec anything' }],
  ['target field', { ...valid, target: { deviceId: 'r1' } }],
  ['empty evidence', { ...valid, citedEvidenceIds: [] }],
  ['invalid id', { ...valid, incidentId: '../../etc/passwd' }],
] as const) {
  test(`proposal rejects ${name}`, () => assert.throws(() => parseProposal(proposal)));
}
