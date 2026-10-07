import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
} from 'firebase-admin/firestore';
import { TOOL_CATALOG } from './tool-catalog.js';
import { actionIdFor, proposalKeyFor } from './proposal-identity.js';
import type {
  ActionRepositoryPort,
  ActionStatus,
  AgentAction,
  AuditEvent,
} from './types.js';

export const ACTION_COLLECTIONS = {
  actions: 'agentActions',
  auditEvents: 'actionAuditEvents',
  agentRuns: 'agentRuns',
} as const;

export class ActionConflictError extends Error {
  constructor() { super('action identity conflicts with the existing proposal'); }
}

export class ProposalValidationError extends Error {}
export class InvalidActionTransitionError extends Error {}

const TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  proposed: ['approved', 'rejected'],
  approved: ['executing'],
  rejected: [],
  executing: ['verifying', 'failed'],
  verifying: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['escalated'],
  escalated: [],
};

/** Firestore persistence boundary for guarded remediation actions. */
export class FirestoreActionRepository implements ActionRepositoryPort {
  constructor(private readonly db: Firestore) {}

  async createOrGet(
    action: AgentAction,
    audit: AuditEvent,
  ): Promise<{ action: AgentAction; created: boolean }> {
    assertCanonicalAction(action);
    assertAudit(action, audit, action.status);
    const actionRef = this.db.collection(ACTION_COLLECTIONS.actions).doc(action.actionId);
    const runRef = this.db.collection(ACTION_COLLECTIONS.agentRuns).doc(action.agentRunId);
    const auditRef = this.db.collection(ACTION_COLLECTIONS.auditEvents)
      .doc(auditId(action.actionId, action.status));

    const created = await this.db.runTransaction(async (transaction) => {
      // Firestore requires every transactional read to precede its writes.
      const [existing, run] = await Promise.all([
        transaction.get(actionRef),
        transaction.get(runRef),
      ]);
      if (existing.exists) {
        const stored = toAction(existing.data());
        if (!sameProposalIdentity(stored, action)) throw new ActionConflictError();
        return false;
      }

      validateCompletedRun(run.exists ? run.data() : undefined, action);
      transaction.create(actionRef, toCreateRecord(action));
      transaction.create(auditRef, toAuditRecord(audit));
      return true;
    });

    return { action: await this.requiredAction(action.actionId), created };
  }

  async get(actionId: string): Promise<AgentAction | null> {
    const snapshot = await this.db.collection(ACTION_COLLECTIONS.actions).doc(actionId).get();
    return snapshot.exists ? toAction(snapshot.data()) : null;
  }

  async list(): Promise<AgentAction[]> {
    const snapshot = await this.db.collection(ACTION_COLLECTIONS.actions).get();
    return snapshot.docs
      .map((document) => toAction(document.data()))
      .sort((left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0));
  }

  async transition(
    actionId: string,
    allowedFrom: ActionStatus[],
    patch: Partial<AgentAction>,
    audit: AuditEvent,
  ): Promise<AgentAction> {
    const nextStatus = patch.status;
    if (nextStatus === undefined) throw new InvalidActionTransitionError('transition status is required');
    assertSafePatch(patch, nextStatus);
    const actionRef = this.db.collection(ACTION_COLLECTIONS.actions).doc(actionId);
    const auditRef = this.db.collection(ACTION_COLLECTIONS.auditEvents)
      .doc(auditId(actionId, nextStatus));

    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(actionRef);
      if (!snapshot.exists) throw new Error('action not found');
      const current = toAction(snapshot.data());
      assertAudit(current, audit, nextStatus);
      if (!allowedFrom.includes(current.status) || !TRANSITIONS[current.status].includes(nextStatus)) {
        throw new InvalidActionTransitionError(`action cannot transition from ${current.status}`);
      }
      const persistedPatch: DocumentData = {
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (nextStatus === 'approved') persistedPatch['approvedAt'] = FieldValue.serverTimestamp();
      transaction.update(actionRef, persistedPatch);
      transaction.create(auditRef, toAuditRecord(audit));
    });

    return this.requiredAction(actionId);
  }

  private async requiredAction(actionId: string): Promise<AgentAction> {
    const action = await this.get(actionId);
    if (action === null) throw new Error('action not found after persistence');
    return action;
  }
}

function validateCompletedRun(data: DocumentData | undefined, action: AgentAction): void {
  if (data === undefined) throw new ProposalValidationError('referenced agent run does not exist');
  if (data['status'] !== 'completed' || data['stage'] !== 'completed') {
    throw new ProposalValidationError('referenced agent run is not completed');
  }
  if (data['runId'] !== action.agentRunId || data['incidentId'] !== action.incidentId) {
    throw new ProposalValidationError('agent run does not belong to the referenced incident');
  }
  const conclusion = object(data['conclusion']);
  const remediation = conclusion === null ? null : object(conclusion['remediationProposal']);
  if (remediation === null || remediation['tool'] !== action.tool) {
    throw new ProposalValidationError('proposal does not match the completed agent conclusion');
  }
  const supported = new Set([
    ...strings(conclusion?.['citedEventIds']),
    ...strings(conclusion?.['citedLogIds']),
  ]);
  const remediationEvidence = new Set(strings(remediation['citedEvidenceIds']));
  if (action.citedEvidenceIds.length === 0 || action.citedEvidenceIds.some((id) =>
    !supported.has(id) || !remediationEvidence.has(id))) {
    throw new ProposalValidationError('proposal cites evidence unsupported by the completed agent conclusion');
  }
}

function toCreateRecord(action: AgentAction): DocumentData {
  return {
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    incidentId: action.incidentId,
    agentRunId: action.agentRunId,
    tool: action.tool,
    rationale: action.rationale,
    citedEvidenceIds: [...action.citedEvidenceIds],
    target: action.target,
    risk: action.risk,
    approvalRequired: action.approvalRequired,
    status: action.status,
    approvedBy: null,
    approvedAt: null,
    preflight: null,
    verification: null,
    error: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function toAuditRecord(audit: AuditEvent): DocumentData {
  return { ...audit, occurredAt: FieldValue.serverTimestamp() };
}

function toAction(data: DocumentData | undefined): AgentAction {
  if (data === undefined) throw new Error('stored action is invalid');
  return {
    actionId: requiredString(data['actionId']),
    idempotencyKey: requiredString(data['idempotencyKey']),
    incidentId: requiredString(data['incidentId']),
    agentRunId: requiredString(data['agentRunId']),
    tool: data['tool'] as AgentAction['tool'],
    rationale: requiredString(data['rationale']),
    citedEvidenceIds: strings(data['citedEvidenceIds']),
    target: data['target'] as AgentAction['target'],
    risk: data['risk'] as AgentAction['risk'],
    approvalRequired: data['approvalRequired'] === true,
    status: data['status'] as ActionStatus,
    approvedBy: typeof data['approvedBy'] === 'string' ? data['approvedBy'] : null,
    approvedAt: date(data['approvedAt']),
    preflight: (data['preflight'] ?? null) as AgentAction['preflight'],
    verification: (data['verification'] ?? null) as AgentAction['verification'],
    error: typeof data['error'] === 'string' ? data['error'] : null,
    createdAt: date(data['createdAt']),
    updatedAt: date(data['updatedAt']),
  };
}

function sameProposalIdentity(left: AgentAction, right: AgentAction): boolean {
  return left.actionId === right.actionId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.incidentId === right.incidentId &&
    left.agentRunId === right.agentRunId &&
    left.tool === right.tool &&
    JSON.stringify([...left.citedEvidenceIds].sort()) ===
      JSON.stringify([...right.citedEvidenceIds].sort());
}

function assertCanonicalAction(action: AgentAction): void {
  const definition = TOOL_CATALOG[action.tool];
  const expectedStatus = action.tool === 'escalate_no_safe_action' ? 'escalated' : 'proposed';
  if (![action.actionId, action.incidentId, action.agentRunId, ...action.citedEvidenceIds]
        .every(safeDocumentIdentifier) || action.idempotencyKey !== proposalKeyFor(action) ||
      action.actionId !== actionIdFor(action)) {
    throw new ProposalValidationError('proposal contains an invalid reference');
  }
  if (definition === undefined || action.status !== expectedStatus ||
      action.risk !== definition.risk || action.approvalRequired !== definition.approvalRequired ||
      JSON.stringify(action.target) !== JSON.stringify(definition.target) ||
      action.approvedBy !== null || action.approvedAt !== null || action.preflight !== null ||
      action.verification !== null || action.error !== null) {
    throw new ActionConflictError();
  }
}

function safeDocumentIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9:_-]+$/.test(value);
}

function assertSafePatch(patch: Partial<AgentAction>, status: ActionStatus): void {
  const fields: Readonly<Record<ActionStatus, readonly (keyof AgentAction)[]>> = {
    proposed: [],
    approved: ['status', 'approvedBy'],
    rejected: ['status', 'approvedBy', 'error'],
    executing: ['status'],
    verifying: ['status', 'preflight'],
    succeeded: ['status', 'verification', 'error'],
    failed: ['status', 'verification', 'error'],
    escalated: ['status', 'error'],
  };
  const allowed = new Set<keyof AgentAction>(fields[status]);
  const unsafe = Object.keys(patch).find((key) => !allowed.has(key as keyof AgentAction));
  if (unsafe !== undefined) throw new ActionConflictError();
  if ((status === 'approved' || status === 'rejected') &&
      (typeof patch.approvedBy !== 'string' || patch.approvedBy.length === 0)) {
    throw new InvalidActionTransitionError('transition requires an approver');
  }
}

function assertAudit(action: Pick<AgentAction, 'actionId' | 'incidentId'>, audit: AuditEvent, status: ActionStatus): void {
  if (audit.actionId !== action.actionId || audit.incidentId !== action.incidentId ||
      audit.transition !== status) throw new Error('audit event does not match action transition');
}

function auditId(actionId: string, status: ActionStatus): string {
  return `${actionId}:${status}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('stored action is invalid');
  return value;
}

function date(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : null;
}
