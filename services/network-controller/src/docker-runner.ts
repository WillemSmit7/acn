import { execFile } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface DockerRunnerPort {
  run(args: readonly string[], timeoutMs: number): Promise<ProcessResult>;
}

export class DockerProcessError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null = null,
    readonly timedOut = false,
  ) { super(message); }
}

/** The executable is code-owned; callers can provide only a fixed adapter argv. */
export class DockerExecFileRunner implements DockerRunnerPort {
  run(args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      execFile('docker', [...args], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error !== null) {
          const timedOut = 'killed' in error && error.killed === true;
          reject(new DockerProcessError(
            timedOut ? 'fixed repair operation timed out' : 'fixed repair operation failed',
            stdout,
            stderr,
            typeof error.code === 'number' ? error.code : null,
            timedOut,
          ));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}
