import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  ACTION_COLLECTIONS,
  ActionConflictError,
  FirestoreActionRepository,
  InvalidActionTransitionError,
  ProposalValidationError,
} from '../src/firestore-repository.js';
import { actionIdFor, proposalKeyFor } from '../src/proposal-identity.js';
import type { ActionStatus, AgentAction, AuditEvent } from '../src/types.js';

test('first creation persists one durable action and one proposal audit', async () => {
  const harness = fixture();
  const result = await harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed'));

  assert.equal(result.created, true);
  assert.equal(result.action.actionId, harness.action.actionId);
  assert.ok(result.action.createdAt instanceof Date);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.actions), 1);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 1);
  const stored = harness.db.read(ACTION_COLLECTIONS.actions, harness.action.actionId);
  assert.ok(stored?.['createdAt'] instanceof Timestamp);
  assert.equal('command' in (stored ?? {}), false);
  assert.equal('parameters' in (stored ?? {}), false);
});

test('exact replay and concurrent duplicates resolve to one action and audit', async () => {
  const harness = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed')),
  ));

  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.action.actionId)).size, 1);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.actions), 1);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 1);
  const replay = await harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed'));
  assert.equal(replay.created, false);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 1);
});

test('an existing id with conflicting immutable identity is rejected safely', async () => {
  const harness = fixture();
  await harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed'));
  harness.db.seed(ACTION_COLLECTIONS.actions, harness.action.actionId, {
    ...harness.db.read(ACTION_COLLECTIONS.actions, harness.action.actionId),
    incidentId: 'INC-OTHER',
  });

  await assert.rejects(
    harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed')),
    (error: unknown) => error instanceof ActionConflictError && !error.message.includes('RUN-001'),
  );
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.actions), 1);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 1);
});

test('missing and incomplete agent runs are rejected before persistence', async () => {
  const missing = fixture({ seedRun: false });
  await assert.rejects(
    missing.repository.createOrGet(missing.action, audit(missing.action, 'proposed')),
    (error: unknown) => error instanceof ProposalValidationError &&
      error.message === 'referenced agent run does not exist',
  );

  const incomplete = fixture({ run: { status: 'running', stage: 'analyzing' } });
  await assert.rejects(
    incomplete.repository.createOrGet(incomplete.action, audit(incomplete.action, 'proposed')),
    (error: unknown) => error instanceof ProposalValidationError &&
      error.message === 'referenced agent run is not completed',
  );
  assert.equal(missing.db.collectionSize(ACTION_COLLECTIONS.actions), 0);
  assert.equal(incomplete.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 0);
});

test('incident/run mismatch and unsupported evidence are rejected with bounded errors', async () => {
  const mismatch = fixture({ run: { incidentId: 'INC-OTHER' } });
  await assert.rejects(
    mismatch.repository.createOrGet(mismatch.action, audit(mismatch.action, 'proposed')),
    /agent run does not belong to the referenced incident/,
  );

  const unsupported = fixture();
  unsupported.action.citedEvidenceIds = ['model-controlled-secret-id'];
  unsupported.action.idempotencyKey = proposalKeyFor(unsupported.action);
  unsupported.action.actionId = actionIdFor(unsupported.action);
  await assert.rejects(
    unsupported.repository.createOrGet(unsupported.action, audit(unsupported.action, 'proposed')),
    (error: unknown) => error instanceof ProposalValidationError &&
      error.message === 'proposal cites evidence unsupported by the completed agent conclusion' &&
      !error.message.includes('model-controlled-secret-id'),
  );
  assert.equal(mismatch.db.collectionSize(ACTION_COLLECTIONS.actions), 0);
  assert.equal(unsupported.db.collectionSize(ACTION_COLLECTIONS.actions), 0);
});

test('transition updates state and appends audit atomically', async () => {
  const harness = fixture();
  await harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed'));
  const approvedAudit = audit(harness.action, 'approved');
  approvedAudit.actor = 'human';
  harness.db.failNextCreate(`${ACTION_COLLECTIONS.auditEvents}/${harness.action.actionId}:approved`);

  await assert.rejects(harness.repository.transition(
    harness.action.actionId,
    ['proposed'],
    { status: 'approved', approvedBy: 'operator@example.test' },
    approvedAudit,
  ), /injected commit failure/);
  assert.equal((await harness.repository.get(harness.action.actionId))?.status, 'proposed');
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 1);

  const approved = await harness.repository.transition(
    harness.action.actionId,
    ['proposed'],
    { status: 'approved', approvedBy: 'operator@example.test' },
    approvedAudit,
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'operator@example.test');
  assert.ok(approved.approvedAt instanceof Date);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 2);
});

test('invalid transitions and immutable-field patches make no writes', async () => {
  const harness = fixture();
  await harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed'));

  await assert.rejects(harness.repository.transition(
    harness.action.actionId,
    ['proposed'],
    { status: 'executing' },
    { ...audit(harness.action, 'executing'), actor: 'controller' },
  ), InvalidActionTransitionError);
  await assert.rejects(harness.repository.transition(
    harness.action.actionId,
    ['proposed'],
    { status: 'approved', tool: 'restore_ospf_cost' },
    { ...audit(harness.action, 'approved'), actor: 'human' },
  ), ActionConflictError);
  assert.equal((await harness.repository.get(harness.action.actionId))?.status, 'proposed');
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 1);
});

test('a forged code-external target cannot be persisted', async () => {
  const harness = fixture();
  harness.action.target = { deviceId: 'r3', component: 'model-selected interface' };
  await assert.rejects(
    harness.repository.createOrGet(harness.action, audit(harness.action, 'proposed')),
    ActionConflictError,
  );
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.actions), 0);
  assert.equal(harness.db.collectionSize(ACTION_COLLECTIONS.auditEvents), 0);
});

function fixture(options: {
  seedRun?: boolean;
  run?: Record<string, unknown>;
} = {}) {
  const db = new FakeFirestore();
  const action = buildAction();
  if (options.seedRun !== false) {
    db.seed(ACTION_COLLECTIONS.agentRuns, action.agentRunId, {
      runId: action.agentRunId,
      incidentId: action.incidentId,
      status: 'completed',
      stage: 'completed',
      conclusion: {
        citedEventIds: ['evt-001'],
        citedLogIds: ['log-001'],
        remediationProposal: {
          tool: action.tool,
          rationale: action.rationale,
          citedEvidenceIds: ['evt-001'],
        },
      },
      ...options.run,
    });
  }
  return {
    db,
    action,
    repository: new FirestoreActionRepository(db as unknown as Firestore),
  };
}

function buildAction(): AgentAction {
  const proposal = {
    incidentId: 'INC-001',
    agentRunId: 'RUN-001',
    tool: 'enable_interface' as const,
    rationale: 'The interface is administratively down.',
    citedEvidenceIds: ['evt-001'],
  };
  return {
    ...proposal,
    actionId: actionIdFor(proposal),
    idempotencyKey: proposalKeyFor(proposal),
    target: { deviceId: 'r2' as const, component: 'eth2 admin state' },
    risk: 'high',
    approvalRequired: true,
    status: 'proposed',
    approvedBy: null,
    approvedAt: null,
    preflight: null,
    verification: null,
    error: null,
    createdAt: null,
    updatedAt: null,
  };
}

function audit(action: AgentAction, transition: ActionStatus): AuditEvent {
  return {
    actionId: action.actionId,
    incidentId: action.incidentId,
    actor: 'ai',
    transition,
    reason: 'bounded test reason',
  };
}

interface FakeRef { collectionName: string; id: string; path: string }
interface FakeSnapshot { exists: boolean; data(): Record<string, unknown> | undefined }
type FakeWrite =
  | { kind: 'create'; ref: FakeRef; data: Record<string, unknown> }
  | { kind: 'update'; ref: FakeRef; data: Record<string, unknown> };

class FakeFirestore {
  private readonly documents = new Map<string, Record<string, unknown>>();
  private queue: Promise<void> = Promise.resolve();
  private clock = 0;
  private failedCreate: string | null = null;

  collection(name: string) {
    return {
      doc: (id: string) => {
        const ref: FakeRef = { collectionName: name, id, path: `${name}/${id}` };
        return { ...ref, get: async () => this.snapshot(ref) };
      },
    };
  }

  async runTransaction<T>(body: (transaction: FakeTransaction) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = (): void => undefined;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const transaction = new FakeTransaction(this);
      const result = await body(transaction);
      transaction.commit();
      return result;
    } finally {
      release();
    }
  }

  seed(collection: string, id: string, data: Record<string, unknown>): void {
    this.documents.set(`${collection}/${id}`, data);
  }

  read(collection: string, id: string): Record<string, unknown> | undefined {
    return this.documents.get(`${collection}/${id}`);
  }

  collectionSize(collection: string): number {
    return [...this.documents.keys()].filter((key) => key.startsWith(`${collection}/`)).length;
  }

  failNextCreate(path: string): void { this.failedCreate = path; }

  snapshot(ref: FakeRef): FakeSnapshot {
    const data = this.documents.get(ref.path);
    return { exists: data !== undefined, data: () => data };
  }

  apply(writes: FakeWrite[]): void {
    for (const write of writes) {
      if (write.kind === 'create' && write.ref.path === this.failedCreate) {
        this.failedCreate = null;
        throw new Error('injected commit failure');
      }
      if (write.kind === 'create' && this.documents.has(write.ref.path)) {
        throw new Error('document already exists');
      }
      if (write.kind === 'update' && !this.documents.has(write.ref.path)) {
        throw new Error('document not found');
      }
    }
    const next = new Map(this.documents);
    for (const write of writes) {
      const prior = next.get(write.ref.path) ?? {};
      next.set(write.ref.path, resolveTimestamps(
        write.kind === 'update' ? { ...prior, ...write.data } : write.data,
        () => Timestamp.fromMillis(++this.clock),
      ));
    }
    this.documents.clear();
    for (const [key, value] of next) this.documents.set(key, value);
  }
}

class FakeTransaction {
  private readonly writes: FakeWrite[] = [];
  constructor(private readonly db: FakeFirestore) {}
  async get(ref: FakeRef): Promise<FakeSnapshot> { return this.db.snapshot(ref); }
  create(ref: FakeRef, data: Record<string, unknown>): void {
    this.writes.push({ kind: 'create', ref, data });
  }
  update(ref: FakeRef, data: Record<string, unknown>): void {
    this.writes.push({ kind: 'update', ref, data });
  }
  commit(): void { this.db.apply(this.writes); }
}

function resolveTimestamps(
  value: Record<string, unknown>,
  now: () => Timestamp,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    item instanceof FieldValue ? now() : item,
  ]));
}
