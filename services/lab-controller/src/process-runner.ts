import { spawn, type ChildProcess } from 'node:child_process';
import type { ScenarioDefinition } from './scenarios.js';
import type { ScenarioRunnerPort } from './types.js';

export class ProcessScenarioRunner implements ScenarioRunnerPort {
  private child: ChildProcess | null = null;

  run(scenario: ScenarioDefinition, onLine: (line: string) => Promise<void>): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(scenario.scriptPath, [], {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      let pending = Promise.resolve();
      let stdout = '';
      let stderr = '';

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
      child.once('error', reject);
      child.once('close', (code) => {
        if (stdout.trim() !== '') pending = pending.then(() => onLine(stdout));
        if (stderr.trim() !== '') pending = pending.then(() => onLine(`ERROR: ${stderr}`));
        void pending.then(() => {
          this.child = null;
          resolve(code ?? 1);
        }, reject);
      });
    });
  }

  stop(): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      this.child?.kill('SIGTERM');
    }
  }
}
