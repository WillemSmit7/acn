import type { LogLevel } from './config/env.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function clockTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Minimal timestamped console logger - no dependency needed for this. */
export function createLogger(level: LogLevel) {
  const threshold = LEVEL_ORDER[level];

  const emit =
    (logLevel: LogLevel, write: (message: string) => void) =>
    (message: string): void => {
      if (LEVEL_ORDER[logLevel] >= threshold) {
        write(`[${clockTime()}] ${message}`);
      }
    };

  return {
    debug: emit('debug', console.debug.bind(console)),
    info: emit('info', console.log.bind(console)),
    warn: emit('warn', console.warn.bind(console)),
    error: emit('error', console.error.bind(console)),
    /** Unprefixed line, for the check result table. */
    line: (message: string): void => console.log(`[${clockTime()}] ${message}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;
