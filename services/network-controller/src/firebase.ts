import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { NetworkControllerConfig } from './config.js';

export function initFirestore(config: NetworkControllerConfig): Firestore {
  process.env.FIRESTORE_EMULATOR_HOST = config.emulatorHost;
  const db = getFirestore(initializeApp({ projectId: config.projectId }));
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}
