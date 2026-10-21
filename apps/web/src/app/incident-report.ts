/** Snapshot-only reporting: never infer approval, recovery, or business savings. */
export interface ReportRecord { id: string; data: Record<string, unknown>; }
export interface IncidentReportInput {
  incident: ReportRecord;
  runs: ReportRecord[];
  events: ReportRecord[];
  logs: ReportRecord[];
  actions: ReportRecord[];
  audits: ReportRecord[];
  warnings: string[];
  generatedAt: Date;
}
export interface ReportSection { title: string; paragraphs: string[]; }
export interface IncidentReport { incidentId: string; generatedAt: string; sections: ReportSection[]; }

/** A newer pending/failed investigation must not expose an older diagnosis as finished. */
export function investigationReportReady(runs: readonly { status: string; startedAt: unknown; conclusion: unknown }[]): boolean {
  const latest = [...runs].sort((a, b) => (reportDate(b.startedAt)?.getTime() ?? 0) - (reportDate(a.startedAt)?.getTime() ?? 0))[0];
  return latest?.status === 'completed' && reportText(reportObject(latest.conclusion)['summary'], '').trim().length > 0;
}

export function reportDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function') {
    return reportDate(value.toDate());
  }
  return null;
}
export function reportTimestamp(value: unknown): string {
  return reportDate(value)?.toISOString() ?? 'Time unavailable';
}
export function reportText(value: unknown, fallback = 'Not recorded'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
export function reportObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function reportIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function elapsed(start: unknown, end: unknown): string {
  const from = reportDate(start), to = reportDate(end);
  if (from === null || to === null || to < from) return 'Unavailable';
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}

export function buildIncidentReport(input: IncidentReportInput): IncidentReport {
  const inc = input.incident.data;
  const runs = [...input.runs].sort((a, b) => (reportDate(b.data['startedAt'])?.getTime() ?? 0) - (reportDate(a.data['startedAt'])?.getTime() ?? 0));
  const latest = runs[0];
  const completed = runs.find(run => run.data['status'] === 'completed' && Object.keys(reportObject(run.data['conclusion'])).length > 0);
  const conclusion = reportObject(completed?.data['conclusion']);
  const citation = reportObject(completed?.data['citedEvidence']);
  const eventIds = reportIds(citation['eventIds'] ?? conclusion['citedEventIds']);
  const logIds = new Set(reportIds(citation['logIds'] ?? conclusion['citedLogIds']));
  const sections: ReportSection[] = [
    { title: 'Summary', paragraphs: [
      reportText(conclusion['summary'], 'No completed diagnosis is available. Investigation may be pending or failed.'),
      `Case status: ${reportText(inc['status'])}. Affected devices: ${reportIds(inc['affectedDevices']).join(', ') || 'Not recorded'}.`,
      ...(latest && latest !== completed ? [`Latest investigation ${latest.id}: ${reportText(latest.data['status'])}.${completed ? ` This summary is from the earlier completed investigation ${completed.id}.` : ' No completed diagnosis is available.'}`] : []),
    ] },
    { title: 'Diagnosis and confidence', paragraphs: [
      `Confidence: ${reportText(conclusion['confidence'], 'Unavailable')}. This is an evidence-based assessment, not a verified probability.`,
      `Diagnosis source: ${completed?.id ?? 'No completed investigation'}; completed ${reportTimestamp(completed?.data['completedAt'])}.`,
      ...reportIds(conclusion['reasoning']),
    ] },
  ];
  const decisions: string[] = [];
  for (const action of input.actions) {
    const data = action.data;
    decisions.push(`${action.id}: ${reportText(data['tool']).replaceAll('_', ' ')}; status ${reportText(data['status'])}; target ${JSON.stringify(data['target'] ?? null)}; risk ${reportText(data['risk'])}.`);
    const audits = input.audits.filter(a => a.data['actionId'] === action.id && ['approved', 'rejected'].includes(reportText(a.data['transition'])));
    for (const audit of audits) decisions.push(`${reportText(audit.data['transition'])} by ${reportText(data['approvedBy'], 'Operator not recorded')} at ${reportTimestamp(audit.data['occurredAt'])}: ${reportText(audit.data['reason'])}`);
    if (audits.length === 0) {
      decisions.push(data['approvedAt'] ? `Approved by ${reportText(data['approvedBy'])} at ${reportTimestamp(data['approvedAt'])}.` : data['status'] === 'rejected' ? `Rejected by ${reportText(data['approvedBy'])}; decision timestamp unavailable. Reason: ${reportText(data['error'])}.` : 'No approval or rejection recorded.');
    }
  }
  const recommendation = reportObject(conclusion['remediationProposal']);
  if (typeof recommendation['tool'] === 'string') {
    sections.push({ title: 'Recommended next step', paragraphs: [
      `${recommendation['tool'].replaceAll('_', ' ')}: ${reportText(recommendation['rationale'])}`,
      'This is the diagnosis recommendation. It does not establish approval, execution or recovery.',
    ] });
  }
  sections.push({ title: 'Decision and outcome', paragraphs: decisions.length ? decisions : ['No controller action or approval/rejection recorded.'] });
  const timeline: { at: unknown; text: string }[] = [{ at: inc['startedAt'], text: 'Incident detected' }];
  for (const event of input.events) timeline.push({ at: event.data['occurredAt'], text: `${event.id} | ${reportText(event.data['source'])} | ${reportText(event.data['deviceId'])} | ${reportText(event.data['eventType']).replaceAll('_', ' ')}` });
  for (const run of runs) {
    timeline.push({ at: run.data['startedAt'], text: `Investigation started: ${run.id}` });
    if (run.data['completedAt']) timeline.push({ at: run.data['completedAt'], text: `Investigation ${reportText(run.data['status'])}: ${run.id}` });
  }
  for (const audit of input.audits) timeline.push({ at: audit.data['occurredAt'], text: `${reportText(audit.data['actor'])} | ${reportText(audit.data['transition'])} | ${reportText(audit.data['reason'])}` });
  if (inc['status'] === 'resolved') timeline.push({ at: inc['resolvedAt'], text: 'Incident resolved by monitoring' });
  timeline.sort((a, b) => (reportDate(a.at)?.getTime() ?? Infinity) - (reportDate(b.at)?.getTime() ?? Infinity));
  sections.push({ title: 'Timeline (UTC)', paragraphs: timeline.map(row => `${reportTimestamp(row.at)} | ${row.text}`) });
  const decisionTimes = input.audits.filter(a => ['approved', 'rejected'].includes(reportText(a.data['transition']))).map(a => reportDate(a.data['occurredAt'])).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime());
  sections.push({ title: 'Time taken', paragraphs: [
    `Detection to completed diagnosis: ${elapsed(inc['startedAt'], completed?.data['completedAt'])}.`,
    `Detection to first decision: ${elapsed(inc['startedAt'], decisionTimes[0])}.`,
    `Detection to resolution: ${inc['status'] === 'resolved' ? elapsed(inc['startedAt'], inc['resolvedAt']) : 'Not resolved'}.`,
    'These are measured elapsed times. No estimate of time or money saved is included.',
  ] });
  const evidence: string[] = [];
  for (const id of eventIds) {
    const event = input.events.find(e => e.id === id);
    if (!event) { evidence.push(`Event ${id}: unavailable.`); continue; }
    const data = event.data;
    evidence.push(`${id} | ${reportTimestamp(data['occurredAt'])} | ${reportText(data['source'])} | ${reportText(data['deviceId'])}\n${JSON.stringify(data['attributes'] ?? {})}`);
    if (typeof data['sourceLogId'] === 'string') logIds.add(data['sourceLogId']);
  }
  for (const id of logIds) {
    const log = input.logs.find(l => l.id === id);
    evidence.push(log ? `${id} | ${reportTimestamp(log.data['receivedAt'])} (received) | ${reportText(log.data['source'])} | ${reportText(log.data['deviceId'])} | ${reportText(log.data['daemon'], 'probe')}\n${reportText(log.data['raw'])}` : `Log ${id}: unavailable.`);
  }
  sections.push({ title: 'Evidence behind the diagnosis', paragraphs: evidence.length ? evidence : ['No cited evidence is available.'] });
  sections.push({ title: 'Report notes', paragraphs: [
    'Records were collected during export and may change while the report is generated; this is not an atomic database snapshot. Operator names are recorded values, not authenticated identities. Log timestamps marked received describe collection time; original timestamps remain in the raw text.',
    ...input.warnings,
  ] });
  return { incidentId: reportText(inc['incidentId'], input.incident.id), generatedAt: input.generatedAt.toISOString(), sections };
}
