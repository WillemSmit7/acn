import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardedActionService, GuardRejectedError } from '../src/action-service.js';
import type {
  ActionProposal,
  ActionRepositoryPort,
  ActionStatus,
  AgentAction,
  AuditEvent,
  GuardResult,
  IncidentGuardPort,
  PreflightResult,
  RemediationExecutorPort,
  RemediationTool,
  VerificationResult,
} from '../src/types.js';

const proposal = {
  incidentId: 'INC-001', agentRunId: 'RUN-001', tool: 'enable_interface',
  rationale: 'Interface administrative state is down.', citedEvidenceIds: ['evt-001'],
};

test('proposal is inert until a human approves it', async () => {
  const harness = fixture();
  const action = await harness.service.propose(proposal);
  assert.equal(action.status, 'proposed');
  assert.equal(harness.executor.executions, 0);
  assert.equal(action.target?.deviceId, 'r2');
  assert.equal(action.target?.component, 'eth2 admin state');
});

test('approved action executes once and succeeds only after verification', async () => {
  const harness = fixture();
  const proposed = await harness.service.propose(proposal);
  const completed = await harness.service.approve(proposed.actionId, 'operator@example.test');
  assert.equal(completed.status, 'succeeded');
  assert.equal(harness.executor.executions, 1);
  assert.deepEqual(harness.repository.audits.map((event) => event.transition), [
    'proposed', 'approved', 'executing', 'verifying', 'succeeded',
  ]);
  const replay = await harness.service.approve(proposed.actionId, 'operator@example.test');
  assert.equal(replay.status, 'succeeded');
  assert.equal(harness.executor.executions, 1);
});

test('duplicate proposals return one action and cannot execute twice', async () => {
  const harness = fixture();
  const first = await harness.service.propose(proposal);
  const duplicate = await harness.service.propose({ ...proposal, rationale: 'Different wording.' });
  assert.equal(duplicate.actionId, first.actionId);
  assert.equal(harness.repository.actions.size, 1);
});

test('a failed precondition causes no mutation', async () => {
  const harness = fixture({ preflightSatisfied: false });
  const proposed = await harness.service.propose(proposal);
  const completed = await harness.service.approve(proposed.actionId, 'operator');
  assert.equal(completed.status, 'failed');
  assert.equal(harness.executor.executions, 0);
});

test('command success without recovery evidence is failure', async () => {
  const harness = fixture({ recovered: false });
  const proposed = await harness.service.propose(proposal);
  const completed = await harness.service.approve(proposed.actionId, 'operator');
  assert.equal(completed.status, 'failed');
  assert.equal(harness.executor.executions, 1);
  assert.match(completed.error ?? '', /not observed/);
});

test('stale incident version is rejected before mutation', async () => {
  const harness = fixture();
  const proposed = await harness.service.propose(proposal);
  harness.guard.version = 'incident-v2';
  const completed = await harness.service.approve(proposed.actionId, 'operator');
  assert.equal(completed.status, 'failed');
  assert.equal(harness.executor.executions, 0);
});

test('closed or invalid incidents cannot create proposals', async () => {
  const harness = fixture({ guardAllowed: false });
  await assert.rejects(() => harness.service.propose(proposal), GuardRejectedError);
  assert.equal(harness.repository.actions.size, 0);
});

test('no-safe-action records escalation without approval or execution', async () => {
  const harness = fixture();
  const action = await harness.service.propose({
    ...proposal, tool: 'escalate_no_safe_action', rationale: 'Evidence is insufficient.',
  });
  assert.equal(action.status, 'escalated');
  assert.equal(action.approvalRequired, false);
  assert.equal(harness.executor.executions, 0);
});

function fixture(options: {
  guardAllowed?: boolean; preflightSatisfied?: boolean; recovered?: boolean;
} = {}) {
  const repository = new MemoryRepository();
  const guard = new Guard(options.guardAllowed ?? true);
  const executor = new Executor(options.preflightSatisfied ?? true, options.recovered ?? true);
  return { repository, guard, executor, service: new GuardedActionService(repository, guard, executor) };
}

class Guard implements IncidentGuardPort {
  version = 'incident-v1';
  constructor(private readonly allowed: boolean) {}
  async validate(_proposal: ActionProposal): Promise<GuardResult> {
    return { allowed: this.allowed, reason: this.allowed ? 'open' : 'incident is resolved', incidentVersion: this.version };
  }
}

class Executor implements RemediationExecutorPort {
  executions = 0;
  constructor(private readonly satisfied: boolean, private readonly recovered: boolean) {}
  async preflight(_tool: RemediationTool): Promise<PreflightResult> {
    return { satisfied: this.satisfied, reason: this.satisfied ? 'fault present' : 'state changed', stateDigest: 'before', snapshot: {} };
  }
  async execute(_tool: RemediationTool): Promise<void> { this.executions += 1; }
  async verify(_action: AgentAction): Promise<VerificationResult> {
    return { recovered: this.recovered, reason: this.recovered ? 'recovery observed' : 'recovery not observed', evidenceIds: [], snapshot: {} };
  }
}

class MemoryRepository implements ActionRepositoryPort {
  readonly actions = new Map<string, AgentAction>();
  readonly audits: AuditEvent[] = [];
  async createOrGet(action: AgentAction, audit: AuditEvent) {
    const existing = this.actions.get(action.actionId);
    if (existing !== undefined) return { action: existing, created: false };
    this.actions.set(action.actionId, structuredClone(action));
    this.audits.push(audit);
    return { action, created: true };
  }
  async get(actionId: string): Promise<AgentAction | null> {
    return structuredClone(this.actions.get(actionId) ?? null);
  }
  async transition(
    actionId: string,
    allowedFrom: ActionStatus[],
    patch: Partial<AgentAction>,
    audit: AuditEvent,
  ): Promise<AgentAction> {
    const current = this.actions.get(actionId);
    if (current === undefined) throw new Error('action not found');
    if (!allowedFrom.includes(current.status)) throw new Error(`invalid transition from ${current.status}`);
    const next = { ...current, ...patch };
    this.actions.set(actionId, structuredClone(next));
    this.audits.push(audit);
    return structuredClone(next);
  }
}
