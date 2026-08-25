import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.js';

export interface LogTailOptions {
  /** Device these files belong to, used only for log messages. */
  deviceId: string;
  /** Container to read from, e.g. "clab-acn-r2". */
  containerName: string;
  /** Paths of the log files inside that container. */
  logPaths: string[];
  /** Docker executable, overridable for hosts that need "sudo docker". */
  dockerBinary: string;
  /** Delay before re-attaching after the tail process exits. */
  restartDelayMs: number;
}

/**
 * Follows a set of log files inside a container and emits complete lines.
 *
 * `docker exec <container> tail -F` is used rather than `docker logs` because
 * FRR daemonizes: once watchfrr forks the daemons, their output no longer
 * reaches the container's stdout, so `docker logs` goes silent after startup
 * and a link failure leaves no trace there at all. FRR's own log files are the
 * only source that actually contains the events.
 *
 * The files are bind-mounted out to lab/logs/<router>/ as well, but FRR creates
 * them mode 600 owned by root, so reading them from the host would need root.
 * Going through Docker sidesteps that. The bind mount is still required for a
 * different reason - it is what gives ospfd a directory it can write to at all.
 *
 * `tail -F` (not `-f`) keeps retrying, so the tail survives a file that does
 * not exist yet or is replaced when the lab is redeployed. `-q` suppresses the
 * "==> file <==" headers tail prints for multiple files, which would otherwise
 * be fed to the parser as though they were log lines.
 */
export class LogTail {
  /** stdin is ignored; stdout and stderr are piped. */
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Holds an incomplete trailing line between stdout chunks. */
  private buffer = '';

  constructor(
    private readonly options: LogTailOptions,
    private readonly onLine: (line: string) => void,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.stopped) return;

    const { deviceId, containerName, logPaths, dockerBinary } = this.options;
    // -n 0 starts at the end of each file: on restart we resume with new lines
    // instead of replaying history that was already normalized.
    const args = ['exec', containerName, 'tail', '-F', '-q', '-n', '0', ...logPaths];

    this.logger.debug(`Tailing ${containerName}: ${logPaths.join(', ')}`);
    const child = spawn(dockerBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      // tail announces a missing file on every retry; before the lab is
      // deployed that is the expected state, not something to shout about.
      if (text !== '' && !/No such file|cannot open|can't open/i.test(text)) {
        this.logger.warn(`${deviceId} tail stderr: ${text}`);
      }
    });

    child.on('error', (error) => {
      this.logger.error(`${deviceId} tail failed to spawn: ${error.message}`);
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      if (this.stopped) return;
      this.logger.warn(
        `${deviceId} tail exited (code=${code ?? 'null'} signal=${signal ?? 'null'}) - reattaching`,
      );
      this.scheduleRestart();
    });
  }

  /** Split a stdout chunk into whole lines, holding any partial remainder. */
  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The final element is either "" (chunk ended on a newline) or a partial
    // line still being written; either way it is not ready to emit.
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        this.onLine(line);
      } catch (error) {
        // One bad line must never take down the collector.
        this.logger.error(
          `Error handling line from ${this.options.deviceId}: ${describe(error)}`,
        );
      }
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer !== undefined) return;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, this.options.restartDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    this.child?.kill('SIGTERM');
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
