/**
 * Read the Firestore emulator back and assert Increment 2's acceptance
 * criteria: raw device logs were captured, normalized into networkEvents, and
 * every derived event can be traced back to the exact line it came from.
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

const [logs, events] = await Promise.all([
  db.collection('networkLogs').get(),
  db.collection('networkEvents').orderBy('occurredAt').get(),
]);

let failures = 0;
const check = (ok, description) => {
  console.log(`  ${ok ? GREEN + 'PASS' + RESET : RED + 'FAIL' + RESET}  ${description}`);
  if (!ok) failures += 1;
};

const logList = logs.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
const eventList = events.docs.map((doc) => doc.data());
const fromLayerZero = eventList.filter((e) => e.source === 'layer-zero');
const fromHealth = eventList.filter((e) => e.source === 'health-service');

console.log(`networkLogs/ ${logs.size}, networkEvents/ ${events.size}`);
console.log(`  ${fromLayerZero.length} from layer-zero, ${fromHealth.length} from health-service\n`);

const counts = {};
for (const event of fromLayerZero) {
  counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
}
for (const [type, count] of Object.entries(counts)) {
  console.log(`  event: ${type} x${count}`);
}
console.log();

const typesSeen = new Set(fromLayerZero.map((e) => e.eventType));
const logsById = new Map(logList.map((log) => [log.id, log]));

check(logs.size > 0, 'networkLogs/ captured raw device log lines');
check(
  logList.every((log) => typeof log.raw === 'string' && log.raw.length > 0),
  'every networkLog stores the original unmodified text',
);
check(
  logList.every((log) => log.receivedAt != null),
  'every networkLog has a server timestamp',
);
check(logList.some((log) => log.deviceId === 'r2'), 'logs were collected from r2');
check(logList.some((log) => log.deviceId === 'r3'), 'logs were collected from r3');

// Increment 2 requires at least three distinct normalized event types.
check(typesSeen.size >= 3, `at least three event types normalized (saw ${typesSeen.size})`);
check(typesSeen.has('interface_down'), 'interface_down was normalized from a log line');
check(typesSeen.has('ospf_neighbor_down'), 'ospf_neighbor_down was normalized from a log line');
check(typesSeen.has('interface_up'), 'interface_up was normalized from a log line');
check(typesSeen.has('ospf_neighbor_up'), 'ospf_neighbor_up was normalized from a log line');

// The back-reference is the point of the whole increment: an event that cannot
// be traced to its source text is not evidence.
check(
  fromLayerZero.length > 0 && fromLayerZero.every((e) => typeof e.sourceLogId === 'string' && e.sourceLogId.length > 0),
  'every layer-zero event carries a sourceLogId',
);
check(
  fromLayerZero.every((e) => logsById.has(e.sourceLogId)),
  'every sourceLogId resolves to a real networkLogs document',
);

const traced = fromLayerZero.find((e) => e.eventType === 'ospf_neighbor_down');
if (traced !== undefined) {
  const source = logsById.get(traced.sourceLogId);
  check(
    source !== undefined && source.raw.includes('AdjChg'),
    'an ospf_neighbor_down traces back to the AdjChg line that produced it',
  );
  if (source !== undefined) console.log(`\n  traced: ${source.raw}\n`);
} else {
  check(false, 'an ospf_neighbor_down traces back to the AdjChg line that produced it');
}

// The link failure must be observable from both ends, which is what makes
// Increment 3 able to tell a link fault from a single-device fault.
check(
  fromLayerZero.some((e) => e.deviceId === 'r2' && e.eventType === 'ospf_neighbor_down') &&
    fromLayerZero.some((e) => e.deviceId === 'r3' && e.eventType === 'ospf_neighbor_down'),
  'the R2-R3 failure was observed independently from both routers',
);

// Layer 0 must not have disturbed the Increment 1 pipeline.
check(fromHealth.length > 0, 'health-service events still land in the same collection');
check(
  fromHealth.every((e) => e.sourceLogId === null),
  'health-service events carry a null sourceLogId (no originating log line)',
);

console.log(`\n=== INCREMENT 2 E2E: ${failures === 0 ? GREEN + 'PASS' : RED + 'FAIL (' + failures + ')'}${RESET} ===`);
process.exit(failures === 0 ? 0 : 1);
