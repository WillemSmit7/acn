import { initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logger.js';

/**
 * Firestore client for the Incident Service.
 *
 * Emulator vs production is decided purely by FIRESTORE_EMULATOR_HOST, which
 * the Admin SDK reads directly. Credentials are never hard-coded and no key
 * material exists in this repo: the emulator needs no credential at all, and
 * against real Firebase the service uses Application Default Credentials
 * (GOOGLE_APPLICATION_CREDENTIALS, or the workload identity it runs under).
 */
export function initFirestore(config: AppConfig, logger: Logger): Firestore {
  let app: App;

  if (config.emulatorHost !== undefined) {
    logger.info(`Firestore: emulator at ${config.emulatorHost} (project ${config.projectId})`);
    // No credential: the Firestore client sees FIRESTORE_EMULATOR_HOST and
    // connects over an insecure channel without authenticating.
    app = initializeApp({ projectId: config.projectId });
  } else {
    logger.warn(
      `Firestore: PRODUCTION project ${config.projectId} (application default credentials)`,
    );
    app = initializeApp({
      projectId: config.projectId,
      credential: applicationDefault(),
    });
  }

  const firestore = getFirestore(app);
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}
