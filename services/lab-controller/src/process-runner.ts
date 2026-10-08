import { spawn, type ChildProcess } from 'node:child_process';
import type { ScenarioDefinition } from './scenarios.js';
import type { ScenarioRunnerPort } from './types.js';

export class ProcessScenarioRunner implements ScenarioRunnerPort {
  private child: ChildProcess | null = null;

  constructor(
    // Bound scenario lifetime so a stalled restore cannot leave dashboard controls locked forever.
    private readonly timeoutMs = 120_000,
    private readonly killGraceMs = 2_000,
  ) {}

  run(scenario: ScenarioDefinition, onLine: (line: string) => Promise<void>): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(scenario.scriptPath, [], {
        cwd: process.cwd(),
        env: process.env,
        // Scenarios invoke subprocesses (for example docker); a dedicated group lets
        // timeout cleanup stop the script and its descendants, not just a shell wrapper.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      let pending = Promise.resolve();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const signalProcessGroup = (signal: NodeJS.Signals): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          process.kill(-pid, signal);
        } catch {
          child.kill(signal);
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        // Ask the whole process group to exit cleanly, then force-stop leftovers.
        signalProcessGroup('SIGTERM');
        killTimer = setTimeout(() => signalProcessGroup('SIGKILL'), this.killGraceMs);
      }, this.timeoutMs);

      const queueLines = (chunk: Buffer, source: 'stdout' | 'stderr'): void => {
        const combined = (source === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
        const lines = combined.split(/\r?\n/);
        const remainder = lines.pop() ?? '';
        if (source === 'stdout') stdout = remainder;
        else stderr = remainder;
        for (const value of lines) {
          const line = source === 'stderr' ? `ERROR: ${value}` : value;
          if (line.trim() !== '') pending = pending.then(() => onLine(line));
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => queueLines(chunk, 'stdout'));
      child.stderr?.on('data', (chunk: Buffer) => queueLines(chunk, 'stderr'));
      child.once('error', (error) => {
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        this.child = null;
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (stdout.trim() !== '') pending = pending.then(() => onLine(stdout));
        if (stderr.trim() !== '') pending = pending.then(() => onLine(`ERROR: ${stderr}`));
        void pending.then(() => {
          this.child = null;
          resolve(timedOut ? 124 : (code ?? 1));
        }, (error: unknown) => {
          this.child = null;
          reject(error);
        });
      });
    });
  }

  stop(): void {
    try {
      const pid = this.child?.pid;
      if (pid === undefined) return;
      process.kill(-pid, 'SIGTERM');
    } catch {
      this.child?.kill('SIGTERM');
    }
  }
}
