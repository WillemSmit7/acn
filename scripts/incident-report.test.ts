import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildIncidentReport, investigationReportReady, type IncidentReportInput } from '../apps/web/src/app/incident-report.ts';
import { renderIncidentPdf } from '../apps/web/src/app/incident-report-pdf.ts';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 10, minutes));
function fixture(): IncidentReportInput {
  return {
    incident: { id: 'INC-REPORT', data: { incidentId: 'INC-REPORT', status: 'open', startedAt: at(0), affectedDevices: ['r3', 'pc2'] } },
    runs: [{ id: 'RUN-REPORT', data: { status: 'completed', startedAt: at(1), completedAt: at(2), conclusion: {
      summary: 'A disabled connection on R2 disrupted traffic toward R3 and PC2. The evidence supports re-enabling that connection; recovery has not yet been verified.',
      confidence: 'high', reasoning: ['R2 reports eth2 administratively down. Native output and failed reachability support the diagnosis.'],
      citedEventIds: ['event-1'], citedLogIds: ['log-1'],
      remediationProposal: { tool: 'enable_interface', rationale: 'Restore R2 eth2 after operator review.' },
    } } }],
    events: [{ id: 'event-1', data: { occurredAt: at(0), deviceId: 'r2', source: 'layer-zero', eventType: 'interface_admin_down', sourceLogId: 'log-1', attributes: { adminState: 'down', interface: 'eth2', quota: 100 } } }],
    logs: [{ id: 'log-1', data: { receivedAt: at(0), deviceId: 'r2', source: 'frr', daemon: 'zebra', raw: '2026-10-12T10:00:00Z eth2 administratively down; café; verbinding beëindig.' } }],
    actions: [{ id: 'ACT-REPORT', data: { status: 'rejected', tool: 'enable_interface', approvedBy: 'Willem', target: { deviceId: 'r2', component: 'eth2' }, risk: 'high' } }],
    audits: [{ id: 'audit-1', data: { actionId: 'ACT-REPORT', actor: 'human', transition: 'rejected', occurredAt: at(3), reason: 'Maintenance window required.' } }],
    warnings: [], generatedAt: at(4),
  };
}
test('PDF eligibility requires the latest investigation to have a completed summary', () => {
  const done = { status: 'completed', startedAt: at(1), conclusion: { summary: 'Evidence supports the diagnosis.' } };
  assert.equal(investigationReportReady([]), false);
  assert.equal(investigationReportReady([done]), true);
  for (const status of ['running', 'failed']) assert.equal(investigationReportReady([done, { ...done, status, startedAt: at(2) }]), false);
  assert.equal(investigationReportReady([{ ...done, conclusion: null }]), false);
  assert.equal(investigationReportReady([{ ...done, conclusion: { summary: '   ' } }]), false);
});
test('report preserves cited raw evidence, qualitative confidence, decisions and measured time', () => {
  const report = buildIncidentReport(fixture());
  const text = JSON.stringify(report);
  assert.match(text, /Confidence: high/);
  assert.match(text, /rejected by Willem at 2026-10-12T10:03:00/);
  assert.match(text, /Maintenance window required/);
  assert.match(text, /Detection to first decision: 0h 3m 0s/);
  assert.match(text, /Detection to resolution: Not resolved/);
  assert.match(text, /quota/);
  assert.match(text, /café; verbinding beëindig/);
  assert.doesNotMatch(text, /ground.truth|AI summary/);
});
test('missing diagnosis and evidence, invalid timings and later failed runs remain explicit', () => {
  const input = fixture();
  input.runs.unshift({ id: 'RUN-FAILED', data: { status: 'failed', startedAt: at(3) } });
  input.logs = [];
  input.incident.data['status'] = 'resolved';
  input.incident.data['resolvedAt'] = at(-1);
  let text = JSON.stringify(buildIncidentReport(input));
  assert.match(text, /earlier completed investigation RUN-REPORT/);
  assert.match(text, /Log log-1: unavailable/);
  assert.match(text, /Detection to resolution: Unavailable/);
  input.runs = [];
  text = JSON.stringify(buildIncidentReport(input));
  assert.match(text, /No completed diagnosis/);
  assert.match(text, /Confidence: Unavailable/);
});
test('recommended repair remains visible when no controller action exists', () => {
  const input = fixture();
  input.actions = [];
  input.audits = [];
  const text = JSON.stringify(buildIncidentReport(input));
  assert.match(text, /Recommended next step/);
  assert.match(text, /Restore R2 eth2 after operator review/);
  assert.match(text, /No controller action or approval\/rejection recorded/);
  assert.doesNotMatch(text, /No proposed repair/);
});
test('renderer paginates long evidence without dropping final text', () => {
  const input = fixture();
  input.logs[0].data['raw'] += '\n' + Array.from({ length: 150 }, (_, i) => `Line ${i}: long evidence string with timestamp and source - original device output.`).join('\n') + '\nEND OF EVIDENCE';
  const report = buildIncidentReport(input);
  const pdf = renderIncidentPdf(report, {
    regular: readFileSync('apps/web/public/fonts/DejaVuSans.ttf').toString('base64'),
    bold: readFileSync('apps/web/public/fonts/DejaVuSans-Bold.ttf').toString('base64'),
  });
  assert.ok(pdf.getNumberOfPages() > 3);
  assert.match(pdf.output(), /^%PDF/);
  if (process.env['ACN_REPORT_QA_PDF']) writeFileSync(process.env['ACN_REPORT_QA_PDF'], Buffer.from(pdf.output('arraybuffer')));
});
