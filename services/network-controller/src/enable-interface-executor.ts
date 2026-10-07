import { createHash } from 'node:crypto';
import { FieldValue, Timestamp, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import type { NetworkControllerConfig } from './config.js';
import { DockerProcessError, type DockerRunnerPort, type ProcessResult } from './docker-runner.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import type {
  AgentAction, PreflightResult, RemediationExecutorPort, RemediationTool, VerificationResult,
} from './types.js';

type ExecutableTool = Exclude<RemediationTool, 'escalate_no_safe_action'>;
type FixedArgv = readonly string[];

const RESTART_ROUTING_SCRIPT = [
  'watch="$(cat /tmp/acn-watchfrr-stopped 2>/dev/null || true)"',
  '[ "$(cat "/proc/$watch/comm" 2>/dev/null || true)" = watchfrr ] || watch=""',
  '[ -n "$watch" ] || watch="$(pidof watchfrr 2>/dev/null || true)"',
  '[ -z "$watch" ] || kill -CONT $watch 2>/dev/null || true',
  'rm -f /tmp/acn-watchfrr-stopped',
  'sleep 2',
  'pidof ospfd >/dev/null 2>&1 || /usr/lib/frr/frrinit.sh restart',
].join('; ');

const RESTORE_RESOURCE_SCRIPT = [
  'if [ -s /tmp/acn-resource-pids ]; then while read -r pid; do [ "$(cat "/proc/$pid/comm" 2>/dev/null || true)" != yes ] || kill -TERM "$pid" 2>/dev/null || true; done < /tmp/acn-resource-pids; fi',
  'for wait in 1 2 3; do pidof yes >/dev/null 2>&1 || break; sleep 1; done',
  'if pidof yes >/dev/null 2>&1; then exit 1; fi',
  'rm -f /tmp/acn-resource-pids',
  'ospf="$(pidof ospfd 2>/dev/null || true)"',
  '[ -z "$ospf" ] || kill -CONT $ospf 2>/dev/null || true',
  'watch="$(cat /tmp/acn-watchfrr-stopped 2>/dev/null || true)"',
  '[ "$(cat "/proc/$watch/comm" 2>/dev/null || true)" = watchfrr ] || watch=""',
  '[ -n "$watch" ] || watch="$(pidof watchfrr 2>/dev/null || true)"',
  '[ -z "$watch" ] || kill -CONT $watch 2>/dev/null || true',
  'rm -f /tmp/acn-watchfrr-stopped',
  'sleep 2',
  'pidof ospfd >/dev/null 2>&1 || /usr/lib/frr/frrinit.sh restart',
].join('; ');

export const FIXED_OPERATION_ARGV: Readonly<Record<ExecutableTool, readonly FixedArgv[]>> = {
  restore_ospf_cost: [[
    'exec', 'clab-acn-r2', 'vtysh', '-c', 'configure terminal',
    '-c', 'interface eth2', '-c', 'no ip ospf cost',
  ]],
  restore_ospf_adjacency: [[
    'exec', 'clab-acn-r2', 'vtysh', '-c', 'configure terminal',
    '-c', 'router ospf', '-c', 'no passive-interface eth2',
  ]],
  enable_interface: [[
    'exec', 'clab-acn-r2', 'vtysh', '-c', 'configure terminal',
    '-c', 'interface eth2', '-c', 'no shutdown',
  ]],
  restart_routing_service: [
    ['exec', 'clab-acn-r3', 'sh', '-c', RESTART_ROUTING_SCRIPT],
  ],
  restore_resource_profile: [
    // Docker update silently ignores a zero NanoCPUs reset on affected engines.
    // One CPU is ACN's explicit approved baseline and inspects as 100 percent.
    ['update', '--cpus', '1', 'clab-acn-r3'],
    ['exec', 'clab-acn-r3', 'sh', '-c', RESTORE_RESOURCE_SCRIPT],
  ],
};

export const ENABLE_INTERFACE_ARGV = FIXED_OPERATION_ARGV.enable_interface[0]!;

const R2_CONTAINER = 'clab-acn-r2';
const R3_CONTAINER = 'clab-acn-r3';
const R2_CONFIG_ARGV = ['exec', R2_CONTAINER, 'vtysh', '-c', 'show running-config'] as const;
const R2_LINK_ARGV = ['exec', R2_CONTAINER, 'ip', '-j', 'link', 'show', 'dev', 'eth2'] as const;
const R3_PROCESS_ARGV = ['exec', R3_CONTAINER, 'pidof', 'ospfd'] as const;
const R3_QUOTA_ARGV = ['inspect', '-f', '{{.HostConfig.NanoCpus}}', R3_CONTAINER] as const;
const RESOURCE_MARKER_ARGV = ['exec', R3_CONTAINER, 'test', '-s', '/tmp/acn-resource-pids'] as const;
const WATCHER_MARKER_ARGV = ['exec', R3_CONTAINER, 'test', '-s', '/tmp/acn-watchfrr-stopped'] as const;

export class GuardRejectedError extends Error {}
export class UnsupportedRepairError extends Error {}

export class FixedRemediationExecutor implements RemediationExecutorPort {
  constructor(
    private readonly db: Firestore,
    private readonly runner: DockerRunnerPort,
    private readonly config: Pick<NetworkControllerConfig,
      'commandTimeoutMs' | 'verificationTimeoutMs' | 'verificationPollMs'>,
  ) {}

  async preflight(action: AgentAction): Promise<PreflightResult> {
    const tool = this.executableTool(action);
    await this.assertIncidentOpen(action.incidentId);
    const snapshot = await this.inspect(tool);
    assertFaultPrecondition(tool, snapshot);
    return { stateDigest: digest(snapshot), snapshot };
  }

  async execute(action: AgentAction): Promise<void> {
    const tool = this.executableTool(action);
    await this.assertIncidentOpen(action.incidentId);
    const before = await this.inspect(tool);
    assertFaultPrecondition(tool, before);
    const changeRef = this.db.collection('networkChanges').doc(`CHANGE-${action.actionId}`);
    await changeRef.create({
      changeId: `CHANGE-${action.actionId}`,
      actionId: action.actionId,
      incidentId: action.incidentId,
      operation: tool,
      deviceId: action.target!.deviceId,
      component: action.target!.component,
      status: 'executing',
      beforeState: before,
      afterState: null,
      transport: null,
      verification: null,
      startedAt: FieldValue.serverTimestamp(),
      completedAt: null,
    });

    const results: ProcessResult[] = [];
    const operations = FIXED_OPERATION_ARGV[tool];
    let failedStep = 1;
    try {
      for (const [index, argv] of operations.entries()) {
        failedStep = index + 1;
        results.push(await this.runner.run(argv, this.config.commandTimeoutMs));
      }
      failedStep = operations.length + 1;
      const after = await this.inspect(tool);
      await changeRef.update({
        status: 'command_completed',
        afterState: after,
        transport: safeTransport(results),
        commandCompletedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      const failed = error instanceof DockerProcessError ? [error] : [];
      const failureStage = failedStep <= operations.length
        ? `step ${failedStep}/${operations.length}`
        : 'post-operation inspection';
      const message = operationFailureMessage(tool, failureStage, error);
      await changeRef.update({
        status: 'failed',
        transport: safeTransport([...results, ...failed], 'failed', {
          failureStage,
          exitCode: error instanceof DockerProcessError ? error.exitCode : null,
          timedOut: error instanceof DockerProcessError && error.timedOut,
        }),
        completedAt: FieldValue.serverTimestamp(),
        error: message,
      });
      if (error instanceof DockerProcessError) {
        throw new DockerProcessError(
          message, error.stdout, error.stderr, error.exitCode, error.timedOut,
        );
      }
      throw error;
    }
  }

  async verify(action: AgentAction): Promise<VerificationResult> {
    const tool = this.executableTool(action);
    const changeRef = this.db.collection('networkChanges').doc(`CHANGE-${action.actionId}`);
    const change = await changeRef.get();
    const startedAt = change.data()?.['startedAt'];
    if (!(startedAt instanceof Timestamp)) throw new Error('repair execution record is incomplete');
    const expectedEvent = TOOL_CATALOG[tool].expectedRecoveryEvent!;
    const deadline = Date.now() + this.config.verificationTimeoutMs;
    while (Date.now() <= deadline) {
      const [incident, recovery] = await Promise.all([
        this.db.collection('incidents').doc(action.incidentId).get(),
        this.db.collection('networkEvents')
          .where('eventType', '==', expectedEvent)
          .where('occurredAt', '>', startedAt)
          .orderBy('occurredAt', 'desc')
          .limit(20)
          .get(),
      ]);
      const evidence = recovery.docs.find((document) => recoveryMatches(tool, document.data()));
      if (incident.data()?.['status'] === 'resolved' && evidence !== undefined) {
        let snapshot: Record<string, unknown>;
        try {
          snapshot = await this.inspect(tool);
          assertHealthyPostcondition(tool, snapshot);
        } catch (error) {
          const result: VerificationResult = {
            recovered: false,
            reason: error instanceof GuardRejectedError
              ? 'fresh observer evidence conflicts with current target state'
              : 'current target state could not be independently verified',
            evidenceIds: [evidence.id],
            snapshot: {},
          };
          await changeRef.update({
            status: 'failed', verification: result, completedAt: FieldValue.serverTimestamp(),
          });
          return result;
        }
        const result: VerificationResult = {
          recovered: true,
          reason: 'fresh autonomous recovery evidence observed and incident resolved',
          evidenceIds: [evidence.id],
          snapshot,
        };
        await changeRef.update({
          status: 'verified', verification: result, completedAt: FieldValue.serverTimestamp(),
        });
        return result;
      }
      await delay(this.config.verificationPollMs);
    }
    const result: VerificationResult = {
      recovered: false,
      reason: 'recovery was not independently observed before timeout',
      evidenceIds: [],
      snapshot: {},
    };
    await changeRef.update({
      status: 'failed', verification: result, completedAt: FieldValue.serverTimestamp(),
    });
    return result;
  }

  private executableTool(action: AgentAction): ExecutableTool {
    if (action.tool === 'escalate_no_safe_action' || action.target === null) {
      throw new UnsupportedRepairError('non-mutating escalation cannot be executed');
    }
    if (JSON.stringify(action.target) !== JSON.stringify(TOOL_CATALOG[action.tool].target)) {
      throw new UnsupportedRepairError('action target does not match the fixed catalog');
    }
    return action.tool;
  }

  private async assertIncidentOpen(incidentId: string): Promise<void> {
    const incident = await this.db.collection('incidents').doc(incidentId).get();
    if (!incident.exists || incident.data()?.['status'] !== 'open') {
      throw new GuardRejectedError('incident is missing or already resolved');
    }
  }

  private async inspect(tool: ExecutableTool): Promise<Record<string, unknown>> {
    return tool === 'restore_ospf_cost' || tool === 'restore_ospf_adjacency' ||
      tool === 'enable_interface' ? this.inspectR2() : this.inspectR3();
  }

  private async inspectR2(): Promise<Record<string, unknown>> {
    await this.assertContainerRunning(R2_CONTAINER);
    const [config, link] = await Promise.all([
      this.runner.run(R2_CONFIG_ARGV, this.config.commandTimeoutMs),
      this.runner.run(R2_LINK_ARGV, this.config.commandTimeoutMs),
    ]);
    const interfaceSection = configSection(config.stdout, 'interface eth2');
    const ospfSection = configSection(config.stdout, 'router ospf');
    if (interfaceSection === '' || ospfSection === '') {
      throw new GuardRejectedError('R2 configuration is missing the fixed repair target');
    }
    const explicitCost = /^\s*ip ospf cost (\d+)\s*$/m.exec(interfaceSection)?.[1];
    const linkState = parseLink(link.stdout);
    return {
      deviceId: 'r2',
      interface: 'eth2',
      ospfCost: explicitCost === undefined ? 10 : Number.parseInt(explicitCost, 10),
      passive: /^\s*passive-interface eth2\s*$/m.test(ospfSection),
      adminState: /^\s*shutdown\s*$/m.test(interfaceSection) || !linkState.up ? 'down' : 'up',
      operState: linkState.operState,
    };
  }

  private async inspectR3(): Promise<Record<string, unknown>> {
    await this.assertContainerRunning(R3_CONTAINER);
    const [process, quota, resourceMarker, watcherMarker] = await Promise.all([
      optional(this.runner, R3_PROCESS_ARGV, this.config.commandTimeoutMs),
      this.runner.run(R3_QUOTA_ARGV, this.config.commandTimeoutMs),
      succeeds(this.runner, RESOURCE_MARKER_ARGV, this.config.commandTimeoutMs),
      succeeds(this.runner, WATCHER_MARKER_ARGV, this.config.commandTimeoutMs),
    ]);
    const processText = process.stdout.trim();
    const nanoCpus = Number.parseInt(quota.stdout.trim(), 10);
    if (!Number.isFinite(nanoCpus)) throw new GuardRejectedError('R3 CPU profile is unreadable');
    return {
      deviceId: 'r3',
      service: 'ospfd',
      processState: processText === '' ? 'missing' : 'present',
      cpuQuotaNanoCpus: nanoCpus,
      cpuQuotaPercent: nanoCpus === 0 ? 100 : Math.round(nanoCpus / 10_000_000),
      resourceMarker,
      watcherMarker,
    };
  }

  private async assertContainerRunning(container: string): Promise<void> {
    const result = await this.runner.run(
      ['inspect', '-f', '{{.State.Running}}', container],
      this.config.commandTimeoutMs,
    );
    if (result.stdout.trim() !== 'true') throw new GuardRejectedError('target router is unavailable');
  }
}

export class EnableInterfaceExecutor extends FixedRemediationExecutor {}

function assertFaultPrecondition(tool: ExecutableTool, state: Record<string, unknown>): void {
  const valid = tool === 'restore_ospf_cost' ?
    state['ospfCost'] !== 10 && state['passive'] === false && state['adminState'] === 'up' :
    tool === 'restore_ospf_adjacency' ?
      state['passive'] === true && state['adminState'] === 'up' && state['ospfCost'] === 10 :
    tool === 'enable_interface' ?
      state['adminState'] === 'down' && state['passive'] === false && state['ospfCost'] === 10 :
    tool === 'restart_routing_service' ?
      state['processState'] === 'missing' &&
        state['cpuQuotaPercent'] === 100 && state['resourceMarker'] === false :
    (state['cpuQuotaNanoCpus'] === 100_000_000 || state['cpuQuotaNanoCpus'] === 1_000_000_000) &&
      (state['resourceMarker'] === true || state['watcherMarker'] === true);
  if (!valid) throw new GuardRejectedError('target state does not match the fixed repair precondition');
}

function assertHealthyPostcondition(tool: ExecutableTool, state: Record<string, unknown>): void {
  const healthy = tool === 'restore_ospf_cost' ?
    state['ospfCost'] === 10 && state['passive'] === false && state['adminState'] === 'up' :
    tool === 'restore_ospf_adjacency' ?
      state['passive'] === false && state['ospfCost'] === 10 && state['adminState'] === 'up' :
    tool === 'enable_interface' ?
      state['adminState'] === 'up' && state['passive'] === false && state['ospfCost'] === 10 :
    tool === 'restart_routing_service' ?
      state['processState'] === 'present' && state['cpuQuotaPercent'] === 100 &&
        state['watcherMarker'] === false :
    state['cpuQuotaNanoCpus'] === 1_000_000_000 && state['processState'] === 'present' &&
      state['resourceMarker'] === false;
  if (!healthy) throw new GuardRejectedError('observer event conflicts with current target state');
}

function recoveryMatches(tool: ExecutableTool, data: DocumentData): boolean {
  const attributes = object(data['attributes']);
  if (data['deviceId'] !== TOOL_CATALOG[tool].target?.deviceId) return false;
  if (tool === 'restart_routing_service') return attributes['service'] === 'ospfd';
  if (tool === 'restore_resource_profile') return attributes['resource'] === 'cpu';
  return attributes['interface'] === 'eth2';
}

function configSection(config: string, heading: string): string {
  const lines = config.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  const body = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (line === '!' || line === 'exit' || (/^\S/.test(line) && line.trim() !== '')) break;
    body.push(line);
  }
  return body.join('\n');
}

function parseLink(value: string): { up: boolean; operState: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new GuardRejectedError('R2 interface state is unreadable');
  }
  const row = Array.isArray(parsed) ? object(parsed[0]) : {};
  if (row['ifname'] !== 'eth2') throw new GuardRejectedError('R2 interface state is mismatched');
  const flags = Array.isArray(row['flags']) ? row['flags'] : [];
  return {
    up: flags.includes('UP'),
    operState: typeof row['operstate'] === 'string' ? row['operstate'] : 'UNKNOWN',
  };
}

async function optional(runner: DockerRunnerPort, argv: FixedArgv, timeout: number): Promise<ProcessResult> {
  try { return await runner.run(argv, timeout); } catch (error) {
    if (error instanceof DockerProcessError && error.exitCode === 1 && !error.timedOut) {
      return { stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}
async function succeeds(runner: DockerRunnerPort, argv: FixedArgv, timeout: number): Promise<boolean> {
  try { await runner.run(argv, timeout); return true; } catch (error) {
    if (error instanceof DockerProcessError && error.exitCode === 1 && !error.timedOut) return false;
    throw error;
  }
}
function safeTransport(
  results: readonly (ProcessResult | DockerProcessError)[],
  outcome = 'completed',
  failure: DocumentData = {},
): DocumentData {
  return {
    outcome,
    stdout: bounded(results.map((result) => result.stdout).join('\n')),
    stderr: bounded(results.map((result) => result.stderr).join('\n')),
    stepCount: results.length,
    ...failure,
  };
}
function bounded(value: string): string { return value.slice(-2_000); }
function operationFailureMessage(tool: ExecutableTool, stage: string, error: unknown): string {
  if (error instanceof DockerProcessError) {
    const detail = error.timedOut ? 'timed out' :
      error.exitCode === null ? 'failed' : `failed with exit ${error.exitCode}`;
    return `fixed ${tool} ${stage} ${detail}`;
  }
  return error instanceof GuardRejectedError
    ? error.message
    : `fixed ${tool} ${stage} failed`;
}
function digest(snapshot: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
