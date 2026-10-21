import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { ControllerConfig } from './config.js';
import type { ActionRepositoryPort, LabAction } from './types.js';
import type { LabGroundTruth } from './scenarios.js';

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

  async finish(action: LabAction, groundTruth?: LabGroundTruth): Promise<void> {
    const actionRef = this.db.collection('labActions').doc(action.id);
    if (groundTruth === undefined) {
      if (action.scenario === 'restore' && action.status === 'completed') {
        const currentRef = this.db.collection('labEvaluationState').doc('current');
        await this.db.runTransaction(async (transaction) => {
          const current = await transaction.get(currentRef);
          const currentData = current.data();
          const pendingId = current.exists && currentData?.['status'] === 'pending' &&
            typeof currentData['evaluationId'] === 'string'
            ? currentData['evaluationId']
            : null;
          transaction.update(actionRef, completionFields(action));
          if (pendingId !== null) {
            transaction.update(this.db.collection('labEvaluations').doc(pendingId), {
              status: 'cancelled',
              cancelledAt: FieldValue.serverTimestamp(),
              cancellationReason: 'network_restored_before_investigation_claim',
            });
          }
          transaction.set(currentRef, {
            evaluationId: null,
            status: 'idle',
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
        return;
      }
      await actionRef.update({
        ...completionFields(action),
      });
      return;
    }

    const evaluationRef = this.db.collection('labEvaluations').doc(action.id);
    const currentRef = this.db.collection('labEvaluationState').doc('current');
    await this.db.runTransaction(async (transaction) => {
      const current = await transaction.get(currentRef);
      const currentData = current.data();
      const previousPendingId = current.exists && currentData?.['status'] === 'pending' &&
        typeof currentData['evaluationId'] === 'string'
        ? currentData['evaluationId']
        : null;
      transaction.update(actionRef, completionFields(action));
      if (previousPendingId !== null && previousPendingId !== action.id) {
        transaction.update(this.db.collection('labEvaluations').doc(previousPendingId), {
          status: 'superseded',
          supersededAt: FieldValue.serverTimestamp(),
          supersededByEvaluationId: action.id,
        });
      }
      transaction.create(evaluationRef, {
        evaluationId: action.id,
        actionId: action.id,
        expected: groundTruth,
        status: 'pending',
        injectionRequestedAt: Timestamp.fromDate(new Date(action.requestedAt)),
        createdAt: FieldValue.serverTimestamp(),
        claimedAt: null,
        claimedByIncidentId: null,
      });
      transaction.set(currentRef, {
        evaluationId: action.id,
        status: 'pending',
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }
}

function completionFields(action: LabAction) {
  return {
    status: action.status,
    output: action.output,
    completedAt: FieldValue.serverTimestamp(),
    exitCode: action.exitCode,
    error: action.error,
  };
}
