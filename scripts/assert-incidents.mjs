/**
 * Read the Firestore emulator back and assert Increment 3's acceptance
 * criteria: related events were correlated into incidents, each incident
 * carries a probable root cause that predicts the observed symptoms, and the
 * two fault scenarios were told apart.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'acn-local';
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set - refusing to assert against production.');
  process.exit(1);
}

const db = getFirestore(initializeApp({ projectId }));

const [incidentsSnap, eventsSnap, logsSnap] = await Promise.all([
  db.collection('incidents').orderBy('startedAt').get(),
  db.collection('networkEvents').get(),
  db.collection('networkLogs').get(),
]);

let failures = 0;
const check = (ok, description) => {
  console.log(`  ${ok ? GREEN + 'PASS' + RESET : RED + 'FAIL' + RESET}  ${description}`);
  if (!ok) failures += 1;
};

const incidents = incidentsSnap.docs.map((doc) => doc.data());
const eventsById = new Map(eventsSnap.docs.map((doc) => [doc.id, doc.data()]));
const logIds = new Set(logsSnap.docs.map((doc) => doc.id));

console.log(`incidents/ ${incidents.length}, networkEvents/ ${eventsSnap.size}, networkLogs/ ${logsSnap.size}\n`);
for (const incident of incidents) {
  console.log(
    `  ${incident.incidentId} [${incident.status}] ${incident.probableRootCause} ` +
      `(${incident.rootCause?.confidence}) events=${incident.eventCount}`,
  );
}
console.log();

const requiredTypes = [
  'configuration_drift',
  'routing_session_failure',
  'interface_misconfiguration',
  'routing_service_failure',
  'resource_exhaustion',
];
check(incidents.length >= 5, `at least five incidents were raised (saw ${incidents.length})`);
for (const type of requiredTypes) {
  check(incidents.some((incident) => incident.rootCauseType === type), `${type} was detected`);
}

check(
  incidents.every((i) => i.rootCause?.predictionMatches === true),
  'every root cause predicts the symptoms that were actually observed',
);

check(
  incidents.every((i) => Array.isArray(i.symptoms) && i.symptoms.length > 0),
  'every incident records its symptoms',
);

check(
  incidents.every((i) => Array.isArray(i.rootCause?.evidence) && i.rootCause.evidence.length > 0),
  'every root cause explains itself with evidence',
);

check(
  incidents.every((i) => i.status === 'resolved'),
  'every incident resolved once the network recovered',
);

check(
  incidents.every((i) => i.resolvedAt != null),
  'every resolved incident records when it resolved',
);

// The full traceability chain: incident -> event -> raw log line.
const allEventIds = incidents.flatMap((i) => i.eventIds ?? []);
check(allEventIds.length > 0, 'incidents reference the events they were built from');
check(
  allEventIds.every((id) => eventsById.has(id)),
  'every referenced event id resolves to a real networkEvents document',
);

const tracedToLog = allEventIds
  .map((id) => eventsById.get(id))
  .filter((event) => event?.sourceLogId != null);
check(
  tracedToLog.length > 0 && tracedToLog.every((event) => logIds.has(event.sourceLogId)),
  'log-derived events in an incident trace all the way back to their raw log line',
);

for (const incident of incidents) {
  console.log(`\n  ${incident.incidentId} evidence:`);
  for (const line of incident.rootCause?.evidence ?? []) console.log(`    - ${line}`);
}

console.log(`\n=== INCREMENT 3 E2E: ${failures === 0 ? GREEN + 'PASS' : RED + 'FAIL (' + failures + ')'}${RESET} ===`);
process.exit(failures === 0 ? 0 : 1);
