import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { ControllerConfig } from './config.js';
import type { ActionRepositoryPort, LabAction } from './types.js';

export function initFirestore(config: ControllerConfig): Firestore {
  process.env.FIRESTORE_EMULATOR_HOST = config.emulatorHost;
  const db = getFirestore(initializeApp({ projectId: config.projectId }));
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

export class ActionRepository implements ActionRepositoryPort {
  constructor(private readonly db: Firestore) {}

  async create(action: LabAction): Promise<void> {
    await this.db.collection('labActions').doc(action.id).create({
      actionId: action.id,
      scenario: action.scenario,
      label: action.label,
      status: action.status,
      output: action.output,
      requestedAt: FieldValue.serverTimestamp(),
      startedAt: FieldValue.serverTimestamp(),
      completedAt: null,
      exitCode: null,
      error: null,
    });
  }

  async updateOutput(action: LabAction): Promise<void> {
    await this.db.collection('labActions').doc(action.id).update({ output: action.output });
  }

  async finish(action: LabAction): Promise<void> {
    await this.db.collection('labActions').doc(action.id).update({
      status: action.status,
      output: action.output,
      completedAt: FieldValue.serverTimestamp(),
      exitCode: action.exitCode,
      error: action.error,
    });
  }
}
