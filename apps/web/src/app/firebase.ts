import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';

/**
 * Firestore connection for the NOC dashboard.
 *
 * This talks to the Firebase EMULATOR, not a real project, and that is a
 * deliberate choice rather than a limitation: a browser app connects to the
 * emulator exactly as it would to production - same SDK, same queries, same
 * live onSnapshot listeners - so nothing about the UI has to change when a real
 * project arrives in Increment 10. Meanwhile the repo needs no credentials, the
 * data stays disposable, and ./scripts/reset-firestore.sh keeps working.
 *
 * The emulator ignores the apiKey, but the SDK insists on the field being
 * present, hence the obvious placeholder.
 */
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8080;
const PROJECT_ID = 'acn-local';

let firestore: Firestore | undefined;

export function db(): Firestore {
  if (firestore !== undefined) return firestore;

  const app: FirebaseApp = initializeApp({
    projectId: PROJECT_ID,
    apiKey: 'emulator-does-not-check-this',
  });

  firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, EMULATOR_HOST, EMULATOR_PORT);
  return firestore;
}

export const emulatorLabel = `${EMULATOR_HOST}:${EMULATOR_PORT} (${PROJECT_ID})`;
