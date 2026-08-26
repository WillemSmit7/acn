import { initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logger.js';

export function initFirestore(config: AppConfig, logger: Logger): Firestore {
  let app: App;
  if (config.emulatorHost !== undefined) {
    logger.info(`Firestore: emulator at ${config.emulatorHost} (project ${config.projectId})`);
    app = initializeApp({ projectId: config.projectId });
  } else {
    logger.warn(`Firestore: PRODUCTION project ${config.projectId} (ADC)`);
    app = initializeApp({ projectId: config.projectId, credential: applicationDefault() });
  }
  const firestore = getFirestore(app);
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}
