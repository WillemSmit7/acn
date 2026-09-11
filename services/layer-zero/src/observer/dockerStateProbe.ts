import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RouterStateSnapshot {
  deviceId: 'r2' | 'r3';
  observedAt: Date;
  /** Exact output returned by the fixed read-only command. */
  raw: string;
  facts: Record<string, string | number | boolean>;
}

export interface StateProbePort {
  inspect(): Promise<RouterStateSnapshot[]>;
}

/**
 * Fixed, read-only inspection of the state affected by the five lab scenarios.
 * No scenario id, device name, interface name, or shell fragment comes from a
 * caller: expanding this surface requires a code change and review.
 */
export class DockerStateProbe implements StateProbePort {
  constructor(
    private readonly dockerBinary: string,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  async inspect(): Promise<RouterStateSnapshot[]> {
    const results = await Promise.allSettled([this.inspectR2(), this.inspectR3()]);
    const snapshots = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.warn(`Router state probe failed: ${String(result.reason)}`);
      }
    }
    if (snapshots.length === 0) {
      const reasons = results.flatMap((result) =>
        result.status === 'rejected' ? [String(result.reason)] : [],
      );
      throw new Error(`all router state probes failed: ${reasons.join('; ')}`);
    }
    return snapshots;
  }

  private async inspectR2(): Promise<RouterStateSnapshot> {
    const raw = await this.run([
      'exec',
      'clab-acn-r2',
      'vtysh',
      '-c',
      'show running-config',
    ]);
    const interfaceSection = configSection(raw, 'interface eth2');
    const ospfSection = configSection(raw, 'router ospf');
    if (interfaceSection === '' || ospfSection === '') {
      throw new Error('R2 running configuration is missing interface eth2 or router ospf');
    }
    const cost = /^\s*ip ospf cost (\d+)\s*$/m.exec(interfaceSection)?.[1];

    return {
      deviceId: 'r2',
      observedAt: new Date(),
      raw,
      facts: {
        ospfCost: cost === undefined ? 10 : Number.parseInt(cost, 10),
        passiveEth2: /^\s*passive-interface eth2\s*$/m.test(ospfSection),
        eth2AdminDown: /^\s*shutdown\s*$/m.test(interfaceSection),
      },
    };
  }

  private async inspectR3(): Promise<RouterStateSnapshot> {
    const raw = await this.run([
      'exec',
      'clab-acn-r3',
      'sh',
      '-c',
      [
        'pid="$(pidof ospfd 2>/dev/null || true)"',
        'if [ -z "$pid" ]; then state=missing; else',
        '  first="${pid%% *}"',
        "  code=\"$(awk '/^State:/{print $2}' /proc/$first/status 2>/dev/null || true)\"",
        '  if [ "$code" = T ] || [ "$code" = t ]; then state=stopped;',
        '  elif [ -n "$code" ]; then state=running; else state=unknown; fi',
        'fi',
        'cpu_max="$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo unknown)"',
        'printf "ospfd=%s\\ncpu.max=%s\\n" "$state" "$cpu_max"',
      ].join('\n'),
    ]);
    const processState = /^ospfd=(missing|stopped|running)$/m.exec(raw)?.[1];
    const cpuMax = /^cpu\.max=(.+)$/m.exec(raw)?.[1]?.trim();
    const cpuQuotaPercent = cpuMax === undefined ? null : quotaPercent(cpuMax);
    if (processState === undefined || cpuQuotaPercent === null) {
      throw new Error('R3 state probe returned an unrecognized process or CPU state');
    }

    return {
      deviceId: 'r3',
      observedAt: new Date(),
      raw,
      facts: {
        ospfdProcessState: processState,
        cpuQuotaPercent,
      },
    };
  }

  private async run(args: string[]): Promise<string> {
    const result = await execFileAsync(this.dockerBinary, args, {
      encoding: 'utf8',
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  }
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

function quotaPercent(cpuMax: string): number | null {
  const [quota, period] = cpuMax.split(/\s+/);
  if (quota === 'max') return 100;
  const quotaValue = Number(quota);
  const periodValue = Number(period);
  if (!Number.isFinite(quotaValue) || !Number.isFinite(periodValue) || periodValue <= 0) {
    return null;
  }
  return Math.round((quotaValue / periodValue) * 100);
}

export const stateProbeInternals = { configSection, quotaPercent };
