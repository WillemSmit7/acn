import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { DockerProcessError, type DockerRunnerPort, type ProcessResult } from '../src/docker-runner.js';
import {
  ENABLE_INTERFACE_ARGV,
  FIXED_OPERATION_ARGV,
  EnableInterfaceExecutor,
  GuardRejectedError,
} from '../src/enable-interface-executor.js';
import { actionIdFor, proposalKeyFor } from '../src/proposal-identity.js';
import { TOOL_CATALOG } from '../src/tool-catalog.js';
import type { AgentAction, RemediationTool } from '../src/types.js';

test('enable-interface uses only the fixed argv and records bounded before/after state', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new FakeRunner();
  const executor = buildExecutor(db, runner);
  const action = buildAction();

  const preflight = await executor.preflight(action);
  assert.equal(preflight.snapshot['adminState'], 'down');
  await executor.execute(action);

  assert.deepEqual(runner.calls.find((args) => args.includes('no shutdown')), [...ENABLE_INTERFACE_ARGV]);
  assert.equal(runner.executions, 1);
  const change = db.read('networkChanges', `CHANGE-${action.actionId}`);
  assert.equal(change?.['operation'], 'enable_interface');
  assert.equal((change?.['beforeState'] as Record<string, unknown>)['adminState'], 'down');
  assert.equal((change?.['afterState'] as Record<string, unknown>)['adminState'], 'up');
  assert.equal('command' in (change ?? {}), false);
});

test('every mutating catalog tool has exact fixed argv and its own precondition', async () => {
  const tools = Object.keys(FIXED_OPERATION_ARGV) as Exclude<RemediationTool, 'escalate_no_safe_action'>[];
  for (const tool of tools) {
    const db = new FakeFirestore();
    db.seed('incidents', 'INC-001', { status: 'open' });
    const runner = new FakeRunner(false, tool);
    const executor = buildExecutor(db, runner);
    const action = buildAction(tool);
    await executor.preflight(action);
    await executor.execute(action);
    assert.deepEqual(runner.operationCalls, FIXED_OPERATION_ARGV[tool].map((argv) => [...argv]));
    assert.equal(db.read('networkChanges', `CHANGE-${action.actionId}`)?.['operation'], tool);
  }
});

test('R3 adapters use fixed BusyBox-compatible recovery scripts and an explicit CPU baseline', () => {
  assert.deepEqual(FIXED_OPERATION_ARGV.restore_resource_profile[0], [
    'update', '--cpus', '1', 'clab-acn-r3',
  ]);
  const resourceScript = FIXED_OPERATION_ARGV.restore_resource_profile[1]?.at(-1) ?? '';
  const restartScript = FIXED_OPERATION_ARGV.restart_routing_service[0]?.at(-1) ?? '';
  for (const script of [resourceScript, restartScript]) {
    assert.match(script, /pidof ospfd/);
    assert.match(script, /frrinit\.sh restart/);
    assert.doesNotMatch(script, /pkill/);
  }
  assert.match(resourceScript, /acn-resource-pids/);
  assert.match(resourceScript, /\/proc\/\$pid\/comm/);
  assert.match(resourceScript, /pidof yes/);
  assert.match(resourceScript, /kill -CONT/);
});

test('resource cleanup accepts its owned partial state and completes idempotently', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new PartialResourceRepairRunner();
  const executor = buildExecutor(db, runner);
  const action = buildAction('restore_resource_profile');

  const preflight = await executor.preflight(action);
  assert.equal(preflight.snapshot['cpuQuotaNanoCpus'], 1_000_000_000);
  assert.equal(preflight.snapshot['processState'], 'missing');
  await executor.execute(action);

  assert.deepEqual(runner.operationCalls, FIXED_OPERATION_ARGV.restore_resource_profile);
  assert.equal(db.read('networkChanges', `CHANGE-${action.actionId}`)?.['status'], 'command_completed');
});

test('routing-service cleanup accepts a missing marker but not an active resource fault', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new RestartWithoutMarkerRunner();
  const executor = buildExecutor(db, runner);
  const action = buildAction('restart_routing_service');

  await executor.preflight(action);
  await executor.execute(action);
  assert.deepEqual(runner.operationCalls, FIXED_OPERATION_ARGV.restart_routing_service);
});

test('healthy or mismatched state is rejected for every fixed adapter', async () => {
  const tools = Object.keys(FIXED_OPERATION_ARGV) as Exclude<RemediationTool, 'escalate_no_safe_action'>[];
  for (const tool of tools) {
    const db = new FakeFirestore();
    db.seed('incidents', 'INC-001', { status: 'open' });
    const runner = new FakeRunner(false, tool, true);
    await assert.rejects(buildExecutor(db, runner).preflight(buildAction(tool)), GuardRejectedError);
    assert.equal(runner.operationCalls.length, 0);
  }
});

test('routing-service repair remains blocked while a resource fault is still active', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new ActiveResourceFaultRunner();
  await assert.rejects(
    buildExecutor(db, runner).preflight(buildAction('restart_routing_service')),
    /target state does not match the fixed repair precondition/,
  );
  assert.equal(runner.operationCalls.length, 0);
});

test('timeout or transport failure stops every adapter and records failure', async () => {
  const tools = Object.keys(FIXED_OPERATION_ARGV) as Exclude<RemediationTool, 'escalate_no_safe_action'>[];
  for (const tool of tools) {
    const db = new FakeFirestore();
    db.seed('incidents', 'INC-001', { status: 'open' });
    const runner = new FakeRunner(true, tool);
    const action = buildAction(tool);
    await assert.rejects(buildExecutor(db, runner).execute(action), DockerProcessError);
    assert.equal(db.read('networkChanges', `CHANGE-${action.actionId}`)?.['status'], 'failed');
    assert.equal(runner.operationCalls.length, 1);
  }
});

test('inspection timeouts cannot masquerade as an absent process or marker', async () => {
  for (const tool of ['restart_routing_service', 'restore_resource_profile'] as const) {
    const db = new FakeFirestore();
    db.seed('incidents', 'INC-001', { status: 'open' });
    const runner = new InspectionFailureRunner(tool);
    await assert.rejects(buildExecutor(db, runner).execute(buildAction(tool)), DockerProcessError);
    assert.equal(runner.operationCalls.length, 0);
    assert.equal(db.read('networkChanges', `CHANGE-${buildAction(tool).actionId}`), undefined);
  }
});

test('every adapter needs its own fresh recovery event plus incident resolution', async () => {
  const tools = Object.keys(FIXED_OPERATION_ARGV) as Exclude<RemediationTool, 'escalate_no_safe_action'>[];
  for (const tool of tools) {
    const db = new FakeFirestore();
    db.seed('incidents', 'INC-001', { status: 'open' });
    const executor = fastExecutor(db, new FakeRunner(false, tool));
    const action = buildAction(tool);
    await executor.execute(action);
    db.seed('incidents', 'INC-001', { status: 'resolved' });
    db.seed('networkEvents', `evt-${tool}`, recoveryEvent(tool));
    assert.equal((await executor.verify(action)).recovered, true);

    const missingDb = new FakeFirestore();
    missingDb.seed('incidents', 'INC-001', { status: 'open' });
    const missingExecutor = fastExecutor(missingDb, new FakeRunner(false, tool));
    await missingExecutor.execute(action);
    missingDb.seed('incidents', 'INC-001', { status: 'resolved' });
    assert.equal((await missingExecutor.verify(action)).recovered, false);
  }
});

test('resolved incident prevents any target inspection or mutation', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'resolved' });
  const runner = new FakeRunner();
  await assert.rejects(buildExecutor(db, runner).preflight(buildAction()), GuardRejectedError);
  assert.equal(runner.calls.length, 0);
  assert.equal(db.read('networkChanges', 'anything'), undefined);
});

test('transport failure is bounded and cannot be mistaken for verification success', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new FakeRunner(true);
  const action = buildAction();
  await assert.rejects(buildExecutor(db, runner).execute(action), DockerProcessError);
  const change = db.read('networkChanges', `CHANGE-${action.actionId}`);
  assert.equal(change?.['status'], 'failed');
  assert.equal(change?.['error'], 'fixed enable_interface step 1/1 timed out');
  assert.equal((change?.['transport'] as Record<string, unknown>)['stdout'], 'x'.repeat(2_000));
  assert.equal((change?.['transport'] as Record<string, unknown>)['failureStage'], 'step 1/1');
  assert.equal((change?.['transport'] as Record<string, unknown>)['timedOut'], true);
});

test('a later fixed-step failure records its exact step and exit code', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new SecondResourceStepFailureRunner();
  const action = buildAction('restore_resource_profile');

  await assert.rejects(
    buildExecutor(db, runner).execute(action),
    /fixed restore_resource_profile step 2\/2 failed with exit 1/,
  );
  const change = db.read('networkChanges', `CHANGE-${action.actionId}`);
  assert.equal(change?.['error'], 'fixed restore_resource_profile step 2/2 failed with exit 1');
  assert.equal((change?.['transport'] as Record<string, unknown>)['failureStage'], 'step 2/2');
  assert.equal((change?.['transport'] as Record<string, unknown>)['exitCode'], 1);
});

test('verification requires both fresh observer evidence and incident resolution', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new FakeRunner();
  const action = buildAction();
  const executor = fastExecutor(db, runner);
  await executor.execute(action);
  const noRecovery = await executor.verify(action);
  assert.equal(noRecovery.recovered, false);

  const recoveredDb = new FakeFirestore();
  recoveredDb.seed('incidents', 'INC-001', { status: 'open' });
  const recoveredRunner = new FakeRunner();
  const recoveredExecutor = fastExecutor(recoveredDb, recoveredRunner);
  await recoveredExecutor.execute(action);
  recoveredDb.seed('incidents', 'INC-001', { status: 'resolved' });
  recoveredDb.seed('networkEvents', 'evt-recovery', {
    eventType: 'interface_admin_up', deviceId: 'r2', attributes: { interface: 'eth2' },
    occurredAt: Timestamp.fromMillis(Date.now() + 10_000),
  });
  const recovery = await recoveredExecutor.verify(action);
  assert.equal(recovery.recovered, true);
  assert.deepEqual(recovery.evidenceIds, ['evt-recovery']);
});

test('fresh recovery evidence cannot override a contradictory live target state', async () => {
  const db = new FakeFirestore();
  db.seed('incidents', 'INC-001', { status: 'open' });
  const runner = new FakeRunner();
  const action = buildAction();
  const executor = fastExecutor(db, runner);
  await executor.execute(action);
  runner.regress();
  db.seed('incidents', 'INC-001', { status: 'resolved' });
  db.seed('networkEvents', 'evt-contradiction', recoveryEvent('enable_interface'));

  const result = await executor.verify(action);
  assert.equal(result.recovered, false);
  assert.match(result.reason, /conflicts/);
  assert.deepEqual(result.evidenceIds, ['evt-contradiction']);
  assert.equal(db.read('networkChanges', `CHANGE-${action.actionId}`)?.['status'], 'failed');
});

function buildExecutor(db: FakeFirestore, runner: DockerRunnerPort): EnableInterfaceExecutor {
  return new EnableInterfaceExecutor(db as unknown as Firestore, runner, {
    commandTimeoutMs: 500,
    verificationTimeoutMs: 1_000,
    verificationPollMs: 100,
  });
}

function fastExecutor(db: FakeFirestore, runner: DockerRunnerPort): EnableInterfaceExecutor {
  return new EnableInterfaceExecutor(db as unknown as Firestore, runner, {
    commandTimeoutMs: 500, verificationTimeoutMs: 5, verificationPollMs: 1,
  });
}

function buildAction(tool: Exclude<RemediationTool, 'escalate_no_safe_action'> = 'enable_interface'): AgentAction {
  const proposal = {
    incidentId: 'INC-001', agentRunId: 'RUN-001', tool,
    rationale: 'Interface is administratively down.', citedEvidenceIds: ['evt-001'],
  };
  return {
    ...proposal,
    actionId: actionIdFor(proposal), idempotencyKey: proposalKeyFor(proposal),
    target: TOOL_CATALOG[tool].target, risk: TOOL_CATALOG[tool].risk,
    approvalRequired: true, status: 'executing', approvedBy: 'operator', approvedAt: new Date(),
    preflight: null, verification: null, error: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

class FakeRunner implements DockerRunnerPort {
  readonly calls: string[][] = [];
  readonly operationCalls: string[][] = [];
  executions = 0;
  private healed: boolean;
  constructor(
    private readonly fail = false,
    private readonly tool: Exclude<RemediationTool, 'escalate_no_safe_action'> = 'enable_interface',
    healthy = false,
  ) { this.healed = healthy; }
  regress(): void { this.healed = false; }
  async run(args: readonly string[]): Promise<ProcessResult> {
    this.calls.push([...args]);
    const operation = FIXED_OPERATION_ARGV[this.tool].some((argv) =>
      JSON.stringify(argv) === JSON.stringify(args),
    );
    if (operation) {
      this.operationCalls.push([...args]);
      this.executions += 1;
      if (this.fail) {
        throw new DockerProcessError(
          'fixed repair operation timed out', 'x'.repeat(3_000), 'secret', null, true,
        );
      }
      this.healed = true;
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
      return { stdout: 'true\n', stderr: '' };
    }
    if (args.includes('{{.HostConfig.NanoCpus}}')) {
      const nanoCpus = this.tool === 'restore_resource_profile'
        ? this.healed ? '1000000000\n' : '100000000\n'
        : '0\n';
      return { stdout: nanoCpus, stderr: '' };
    }
    if (args.includes('show running-config')) {
      const cost = this.tool === 'restore_ospf_cost' && !this.healed ? ' ip ospf cost 65535\n' : '';
      const shutdown = this.tool === 'enable_interface' && !this.healed ? ' shutdown\n' : '';
      const passive = this.tool === 'restore_ospf_adjacency' && !this.healed
        ? ' passive-interface eth2\n' : '';
      return { stdout: `interface eth2\n${cost}${shutdown}!\nrouter ospf\n${passive}!\n`, stderr: '' };
    }
    if (args.includes('link')) {
      const down = this.tool === 'enable_interface' && !this.healed;
      return {
        stdout: JSON.stringify([{ ifname: 'eth2', flags: down ? [] : ['UP'], operstate: down ? 'DOWN' : 'UP' }]),
        stderr: '',
      };
    }
    if (args.includes('pidof')) {
      if (this.tool === 'restart_routing_service' && !this.healed) {
        throw new DockerProcessError('not running', '', '', 1);
      }
      return { stdout: '123\n', stderr: '' };
    }
    if (args.includes('test')) {
      const path = args.at(-1);
      const exists = !this.healed && (path === '/tmp/acn-watchfrr-stopped' ||
        (path === '/tmp/acn-resource-pids' && this.tool === 'restore_resource_profile'));
      if (!exists) throw new DockerProcessError('marker absent', '', '', 1);
      return { stdout: '', stderr: '' };
    }
    return {
      stdout: '', stderr: '',
    };
  }
}

class InspectionFailureRunner extends FakeRunner {
  constructor(tool: 'restart_routing_service' | 'restore_resource_profile') {
    super(false, tool);
  }
  override async run(args: readonly string[]): Promise<ProcessResult> {
    if (args.includes('pidof') || args.includes('test')) {
      throw new DockerProcessError('inspection timed out', '', '', null, true);
    }
    return super.run(args);
  }
}

class ActiveResourceFaultRunner extends FakeRunner {
  constructor() { super(false, 'restart_routing_service'); }
  override async run(args: readonly string[]): Promise<ProcessResult> {
    if (args.includes('{{.HostConfig.NanoCpus}}')) {
      return { stdout: '100000000\n', stderr: '' };
    }
    if (args.at(-1) === '/tmp/acn-resource-pids') return { stdout: '', stderr: '' };
    return super.run(args);
  }
}

class SecondResourceStepFailureRunner extends FakeRunner {
  private operationIndex = 0;
  constructor() { super(false, 'restore_resource_profile'); }
  override async run(args: readonly string[]): Promise<ProcessResult> {
    const operation = FIXED_OPERATION_ARGV.restore_resource_profile.some((argv) =>
      JSON.stringify(argv) === JSON.stringify(args),
    );
    if (operation) {
      this.operationIndex += 1;
      if (this.operationIndex === 2) {
        this.operationCalls.push([...args]);
        throw new DockerProcessError('operation failed', '', '', 1);
      }
    }
    return super.run(args);
  }
}

class PartialResourceRepairRunner extends FakeRunner {
  private partial = true;
  constructor() { super(false, 'restore_resource_profile'); }
  override async run(args: readonly string[]): Promise<ProcessResult> {
    if (this.partial && args.includes('{{.HostConfig.NanoCpus}}')) {
      return { stdout: '1000000000\n', stderr: '' };
    }
    if (this.partial && args.includes('pidof')) {
      throw new DockerProcessError('not running', '', '', 1);
    }
    const operation = FIXED_OPERATION_ARGV.restore_resource_profile.some((argv) =>
      JSON.stringify(argv) === JSON.stringify(args),
    );
    const result = await super.run(args);
    if (operation) this.partial = false;
    return result;
  }
}

class RestartWithoutMarkerRunner extends FakeRunner {
  constructor() { super(false, 'restart_routing_service'); }
  override async run(args: readonly string[]): Promise<ProcessResult> {
    if (args.at(-1) === '/tmp/acn-watchfrr-stopped') {
      throw new DockerProcessError('marker absent', '', '', 1);
    }
    return super.run(args);
  }
}

function recoveryEvent(tool: Exclude<RemediationTool, 'escalate_no_safe_action'>) {
  const attributes = tool === 'restart_routing_service' ? { service: 'ospfd' } :
    tool === 'restore_resource_profile' ? { resource: 'cpu' } : { interface: 'eth2' };
  return {
    eventType: TOOL_CATALOG[tool].expectedRecoveryEvent,
    deviceId: TOOL_CATALOG[tool].target!.deviceId,
    attributes,
    occurredAt: Timestamp.fromMillis(Date.now() + 10_000),
  };
}

class FakeFirestore {
  readonly docs = new Map<string, Record<string, unknown>>();
  collection(name: string) {
    return {
      doc: (id: string) => ({
        get: async () => this.snapshot(name, id),
        create: async (data: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          if (this.docs.has(key)) throw new Error('document already exists');
          this.docs.set(key, timestamps(data));
        },
        update: async (data: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          const current = this.docs.get(key);
          if (current === undefined) throw new Error('document does not exist');
          this.docs.set(key, { ...current, ...timestamps(data) });
        },
      }),
      where: (field: string, operator: string, value: unknown) =>
        new FakeQuery(this, name).where(field, operator, value),
    };
  }
  seed(collection: string, id: string, data: Record<string, unknown>): void {
    this.docs.set(`${collection}/${id}`, data);
  }
  read(collection: string, id: string): Record<string, unknown> | undefined {
    return this.docs.get(`${collection}/${id}`);
  }
  private snapshot(collection: string, id: string) {
    const data = this.read(collection, id);
    return { exists: data !== undefined, data: () => data };
  }
}

class FakeQuery {
  private readonly filters: Array<[string, string, unknown]> = [];
  private maximum = Number.POSITIVE_INFINITY;
  constructor(private readonly db: FakeFirestore, private readonly collection: string) {}
  where(field: string, operator: string, value: unknown): FakeQuery {
    this.filters.push([field, operator, value]);
    return this;
  }
  orderBy(): FakeQuery { return this; }
  limit(value: number): FakeQuery { this.maximum = value; return this; }
  async get() {
    const prefix = `${this.collection}/`;
    const docs = [...this.db.docs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data }))
      .filter((document) => this.filters.every(([field, operator, expected]) => {
        const actual = document.data()[field];
        if (operator === '==') return actual === expected;
        if (operator === '>' && actual instanceof Timestamp && expected instanceof Timestamp) {
          return actual.toMillis() > expected.toMillis();
        }
        return false;
      }))
      .slice(0, this.maximum);
    return { docs };
  }
}

function timestamps(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key, value instanceof FieldValue ? Timestamp.now() : value,
  ]));
}
