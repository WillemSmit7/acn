/**
 * Read the Firestore emulator back and assert Increment 1's acceptance
 * criteria: health checks were recorded, and a healthy -> down -> healthy
 * cycle produced device_unreachable followed by device_recovered.
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

const [devices, checks, events] = await Promise.all([
  db.collection('devices').get(),
  db.collection('healthChecks').get(),
  db.collection('networkEvents').orderBy('occurredAt').get(),
]);

let failures = 0;
const check = (ok, description) => {
  console.log(`  ${ok ? GREEN + 'PASS' + RESET : RED + 'FAIL' + RESET}  ${description}`);
  if (!ok) failures += 1;
};

console.log(`devices/ ${devices.size}, healthChecks/ ${checks.size}, networkEvents/ ${events.size}\n`);

const eventList = events.docs.map((doc) => doc.data());
for (const event of eventList) {
  console.log(`  event: ${event.deviceId} ${event.eventType} (${event.severity})`);
}
console.log();

const unreachable = eventList.filter((e) => e.eventType === 'device_unreachable');
const recovered = eventList.filter((e) => e.eventType === 'device_recovered');

check(devices.size > 0, 'devices/ is populated');
check(checks.size > 0, 'healthChecks/ received documents');
check(checks.docs.every((d) => d.data().checkedAt != null), 'every healthCheck has a server timestamp');
check(checks.docs.some((d) => d.data().status === 'healthy'), 'at least one healthy check was recorded');
check(checks.docs.some((d) => d.data().status === 'down'), 'at least one down check was recorded');
check(unreachable.some((e) => e.deviceId === 'r3'), 'device_unreachable was emitted for r3');
check(recovered.some((e) => e.deviceId === 'r3'), 'device_recovered was emitted for r3');

const r3Sequence = eventList.filter((e) => e.deviceId === 'r3').map((e) => e.eventType);
check(
  r3Sequence.indexOf('device_unreachable') >= 0 &&
    r3Sequence.indexOf('device_unreachable') < r3Sequence.indexOf('device_recovered'),
  'r3 went unreachable before it recovered',
);

console.log(`\n=== INCREMENT 1 E2E: ${failures === 0 ? GREEN + 'PASS' : RED + 'FAIL (' + failures + ')'}${RESET} ===`);
process.exit(failures === 0 ? 0 : 1);
