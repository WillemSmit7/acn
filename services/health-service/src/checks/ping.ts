import { execFile } from 'node:child_process';

/**
 * ICMP reachability via the system `ping` binary.
 *
 * Deliberately not a raw-socket library: raw ICMP sockets need CAP_NET_RAW,
 * and /bin/ping already carries that capability on Ubuntu. This keeps the
 * service dependency-free and runnable as an unprivileged user.
 */

export interface PingOptions {
  /** Echo requests to send. Host is reachable if at least one reply arrives. */
  count: number;
  /** Per-reply wait in seconds. Also used as the overall deadline. */
  timeoutSeconds: number;
}

export interface PingResult {
  reachable: boolean;
  /** Best observed round-trip time in ms, or null when nothing replied. */
  latencyMs: number | null;
  error?: string;
}

/**
 * Extract the lowest round-trip time from `ping` output.
 *
 * Returns null when no reply line is present. Handles both the `time=1.23 ms`
 * and `time<1 ms` forms, and tolerates locale-independent iputils output.
 */
export function parsePingLatencyMs(stdout: string): number | null {
  const matches = [...stdout.matchAll(/time[=<]\s*([\d.]+)\s*ms/gi)];
  if (matches.length === 0) return null;

  const times = matches
    .map((match) => Number.parseFloat(match[1] ?? ''))
    .filter((value) => Number.isFinite(value));

  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * `ping` exits 0 on at least one reply, 1 when the host did not answer, and
 * 2 on a usage/resolution error. Only exit code 1 is a genuine "device down";
 * anything else means the check itself could not be performed.
 */
export function classifyPingExit(code: number | null, stderr: string): PingResult | null {
  if (code === 1) {
    return { reachable: false, latencyMs: null, error: 'no reply within timeout' };
  }
  if (code !== 0) {
    const detail = stderr.trim() || `ping exited with code ${code}`;
    return { reachable: false, latencyMs: null, error: `check failed: ${detail}` };
  }
  return null;
}

export function ping(target: string, options: PingOptions): Promise<PingResult> {
  const args = [
    '-n',                               // no reverse DNS - keeps checks fast
    '-c', String(options.count),
    '-W', String(options.timeoutSeconds), // per-reply timeout
    '-w', String(options.timeoutSeconds * options.count + 1), // overall deadline
    target,
  ];

  return new Promise((resolve) => {
    execFile(
      'ping',
      args,
      // Hard ceiling in case ping ignores its own deadline.
      { timeout: (options.timeoutSeconds * options.count + 5) * 1000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? null);

        if (error !== null && typeof code !== 'number') {
          // ping could not be spawned or was killed - a check failure, not a
          // device failure, but still recorded as "down" so gaps are visible.
          resolve({ reachable: false, latencyMs: null, error: `check failed: ${error.message}` });
          return;
        }

        const failure = classifyPingExit(code, stderr);
        if (failure !== null) {
          resolve(failure);
          return;
        }

        resolve({ reachable: true, latencyMs: parsePingLatencyMs(stdout) });
      },
    );
  });
}
