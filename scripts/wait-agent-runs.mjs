import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set - refusing to query production.');
  process.exit(1);
}

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'acn-local';
const expected = Number.parseInt(process.argv[2] ?? '2', 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? '120000', 10);
const db = getFirestore(initializeApp({ projectId }));
const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
  const snapshot = await db.collection('agentRuns').get();
  const statuses = snapshot.docs.map((doc) => doc.data().status);
  const finished = statuses.filter((status) => status === 'completed' || status === 'failed').length;
  if (snapshot.size >= expected && finished >= expected) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

console.error(`Timed out waiting for ${expected} completed agent run(s).`);
process.exit(1);
