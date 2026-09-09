import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set - refusing to assert against production.');
  process.exit(1);
}

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'acn-local';
const db = getFirestore(initializeApp({ projectId }));
const [runsSnap, incidentsSnap, eventsSnap, logsSnap] = await Promise.all([
  db.collection('agentRuns').get(),
  db.collection('incidents').get(),
  db.collection('networkEvents').get(),
  db.collection('networkLogs').get(),
]);

const runs = runsSnap.docs.map((doc) => doc.data());
const incidents = new Map(incidentsSnap.docs.map((doc) => [doc.id, doc.data()]));
const eventIds = new Set(eventsSnap.docs.map((doc) => doc.id));
const logIds = new Set(logsSnap.docs.map((doc) => doc.id));
let failures = 0;
const check = (ok, description) => {
  console.log(`  ${ok ? GREEN + 'PASS' + RESET : RED + 'FAIL' + RESET}  ${description}`);
  if (!ok) failures += 1;
};

console.log(`agentRuns/ ${runs.length}, incidents/ ${incidents.size}\n`);
for (const run of runs) {
  console.log(
    `  ${run.runId} [${run.status}] ${run.conclusion?.summary ?? run.error?.message ?? run.stage} ` +
    `(${run.agreement ?? 'n/a'})`,
  );
}
console.log();

const completed = runs.filter((run) => run.status === 'completed');
check(completed.length >= 5, `at least five investigations completed (saw ${completed.length})`);
check(runs.every((run) => run.status === 'completed'), 'no investigation failed or remained running');
check(runs.every((run) => incidents.has(run.incidentId)), 'every run references a real incident');
check(
  runs.every((run) => run.model === 'gpt-5.6-luna' && run.reasoningEffort === 'low'),
  'every run used GPT-5.6 Luna with low reasoning effort',
);
check(
  runs.every((run) => run.agreement === 'agree' || run.agreement === 'disagree'),
  'every completed run explicitly records agreement or disagreement',
);
check(
  runs.every((run) => Array.isArray(run.evidenceRefs?.eventIds) &&
    run.evidenceRefs.eventIds.length > 0 && run.evidenceRefs.eventIds.every((id) => eventIds.has(id))),
  'every inspected event id resolves to a real networkEvents document',
);
check(
  runs.every((run) => Array.isArray(run.evidenceRefs?.logIds) &&
    run.evidenceRefs.logIds.length > 0 && run.evidenceRefs.logIds.every((id) => logIds.has(id))),
  'every inspected log id resolves to a real networkLogs document',
);
check(
  completed.every((run) => run.citedEvidence?.eventIds?.length > 0 &&
    run.citedEvidence.eventIds.every((id) => eventIds.has(id))),
  'every conclusion cites real normalized events',
);
check(
  completed.every((run) => run.citedEvidence?.logIds?.length > 0 &&
    run.citedEvidence.logIds.every((id) => logIds.has(id))),
  'every conclusion cites real raw device logs',
);
check(
  completed.every((run) => run.usage?.inputTokens > 0 && run.usage?.outputTokens > 0 &&
    run.usage?.totalTokens > 0),
  'token usage is recorded for every completed run',
);
check(
  completed.every((run) => typeof run.latencyMs === 'number' && run.latencyMs >= 0 &&
    typeof run.estimatedCostUsd === 'number' && run.estimatedCostUsd >= 0),
  'latency and estimated cost are recorded for every completed run',
);
check(
  completed.every((run) => run.prompt?.version && run.prompt?.developer && run.prompt?.input),
  'the exact reproduction prompt is retained',
);

const types = new Set(completed.map((run) => run.conclusion?.rootCauseType));
for (const type of [
  'configuration_drift',
  'routing_session_failure',
  'interface_misconfiguration',
  'routing_service_failure',
  'resource_exhaustion',
]) check(types.has(type), `Luna identified ${type}`);

console.log(`\n=== INCREMENT 4 E2E: ${failures === 0 ? GREEN + 'PASS' : RED + 'FAIL (' + failures + ')'}${RESET} ===`);
process.exit(failures === 0 ? 0 : 1);
