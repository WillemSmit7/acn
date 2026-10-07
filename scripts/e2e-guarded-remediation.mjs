import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'acn-local';
const controller = process.env.NETWORK_CONTROLLER_URL ?? 'http://127.0.0.1:8788';
const tool = required('EXPECTED_REMEDIATION_TOOL');
const cause = required('EXPECTED_ROOT_CAUSE');
const faultEvent = required('EXPECTED_FAULT_EVENT');
const db = getFirestore(initializeApp({ projectId }, 'guarded-remediation-e2e'));
const deadline = Date.now() + 90_000;

const incident = await waitFor(async () => {
  const snapshot = await db.collection('incidents').where('status', '==', 'open').get();
  return snapshot.docs.find((document) =>
    document.data().rootCauseType === cause &&
    Array.isArray(document.data().eventIds));
}, 'open interface-misconfiguration incident');

const events = await db.getAll(...incident.data().eventIds.map((id) =>
  db.collection('networkEvents').doc(id),
));
const evidence = events.find((document) => document.data()?.eventType === faultEvent);
if (evidence === undefined) throw new Error(`incident has no ${faultEvent} evidence`);

const runId = `RUN-E2E-${Date.now()}`;
await db.collection('agentRuns').doc(runId).create({
  runId,
  incidentId: incident.id,
  status: 'completed',
  stage: 'completed',
  provider: 'fixture',
  conclusion: {
    rootCauseType: cause,
    rootCauseDevices: tool === 'restart_routing_service' || tool === 'restore_resource_profile'
      ? ['r3'] : ['r2'],
    summary: `Deterministic fixture diagnosis for ${tool}`,
    confidence: 'high',
    reasoning: ['Autonomous state evidence reports the fixed interface administratively down.'],
    citedEventIds: [evidence.id],
    citedLogIds: [],
    remediationProposal: {
      tool,
      rationale: `Apply the fixed ${tool} adapter to its catalog-owned target.`,
      citedEvidenceIds: [evidence.id],
    },
  },
});

const action = await waitFor(async () => {
  const snapshot = await db.collection('agentActions').where('agentRunId', '==', runId).get();
  return snapshot.docs[0];
}, 'durable inert action proposal');
if (action.data().status !== 'proposed') throw new Error(`expected proposed action, got ${action.data().status}`);

const response = await fetch(`${controller}/api/actions/${encodeURIComponent(action.id)}/approve`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ approver: 'e2e-operator' }),
});
const body = await response.json();
if (!response.ok) throw new Error(`approval failed: ${body.error ?? response.status}`);
if (body.action?.status !== 'succeeded') throw new Error(`expected succeeded action, got ${body.action?.status}`);

const [audits, change] = await Promise.all([
  db.collection('actionAuditEvents').where('actionId', '==', action.id).get(),
  db.collection('networkChanges').doc(`CHANGE-${action.id}`).get(),
]);
const transitions = new Set(audits.docs.map((document) => document.data().transition));
for (const expected of ['proposed', 'approved', 'executing', 'verifying', 'succeeded']) {
  if (!transitions.has(expected)) throw new Error(`missing ${expected} audit event`);
}
if (change.data()?.status !== 'verified' || change.data()?.verification?.recovered !== true) {
  throw new Error('network change was not independently verified');
}

console.log(`Guarded remediation E2E passed: ${incident.id} -> ${runId} -> ${action.id}`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function waitFor(load, label) {
  while (Date.now() < deadline) {
    const value = await load();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
}
