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

const linkIncident = incidents.find((i) => i.rootCauseType === 'link_failure');
const deviceIncident = incidents.find((i) => i.rootCauseType === 'device_failure');

check(incidents.length >= 2, `at least two incidents were raised (saw ${incidents.length})`);

// The headline claim of Increment 3. Both scenarios cut off exactly the same
// devices, so ICMP alone cannot separate them - only the log evidence can.
check(linkIncident !== undefined, 'scenario 01 was diagnosed as a link failure');
check(deviceIncident !== undefined, 'scenario 02 was diagnosed as a device failure');
check(
  linkIncident !== undefined &&
    deviceIncident !== undefined &&
    linkIncident.incidentId !== deviceIncident.incidentId,
  'the two scenarios produced different incidents with different root causes',
);

if (linkIncident !== undefined) {
  check(
    JSON.stringify([...(linkIncident.rootCause?.devices ?? [])].sort()) === JSON.stringify(['r2', 'r3']),
    'the link failure implicates exactly r2 and r3',
  );
  check(
    linkIncident.rootCause?.confidence === 'confirmed',
    'the link failure is confirmed - both ends reported independently',
  );
}

if (deviceIncident !== undefined) {
  check(
    JSON.stringify(deviceIncident.rootCause?.devices ?? []) === JSON.stringify(['r3']),
    'the device failure implicates exactly r3',
  );
}

// Both scenarios must have produced identical observed symptoms; that is what
// makes the differing diagnosis meaningful rather than lucky.
if (linkIncident !== undefined && deviceIncident !== undefined) {
  const linkObserved = JSON.stringify([...(linkIncident.rootCause?.observedUnreachable ?? [])].sort());
  const deviceObserved = JSON.stringify([...(deviceIncident.rootCause?.observedUnreachable ?? [])].sort());
  check(
    linkObserved === deviceObserved && linkObserved === JSON.stringify(['pc2', 'r3']),
    'both scenarios produced the same observed symptoms (pc2, r3 unreachable)',
  );
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

if (linkIncident !== undefined) {
  console.log(`\n  ${linkIncident.incidentId} evidence:`);
  for (const line of linkIncident.rootCause?.evidence ?? []) console.log(`    - ${line}`);
}
if (deviceIncident !== undefined) {
  console.log(`\n  ${deviceIncident.incidentId} evidence:`);
  for (const line of deviceIncident.rootCause?.evidence ?? []) console.log(`    - ${line}`);
}

console.log(`\n=== INCREMENT 3 E2E: ${failures === 0 ? GREEN + 'PASS' : RED + 'FAIL (' + failures + ')'}${RESET} ===`);
process.exit(failures === 0 ? 0 : 1);
