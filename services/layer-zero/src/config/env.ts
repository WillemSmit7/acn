import 'dotenv/config';

/** Runtime configuration, resolved once at startup from the environment. */
export interface AppConfig {
  projectId: string;
  /** Set when Layer 0 targets the Firestore emulator instead of production. */
  emulatorHost: string | undefined;
  /** Docker executable - hosts needing "sudo docker" can override it. */
  dockerBinary: string;
  /** How long collected lines are buffered before being written as one batch. */
  flushIntervalMs: number;
  /** Delay before re-attaching a tail that died. */
  restartDelayMs: number;
  /** Interval for autonomous read-only router state inspection. */
  observerIntervalMs: number;
  logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Invalid ${name}="${raw}" - expected an integer >= ${min}`);
  }
  return parsed;
}

function logLevelFromEnv(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  throw new Error(`Invalid LOG_LEVEL="${raw}" - expected debug|info|warn|error`);
}

export function loadConfig(): AppConfig {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID ?? 'acn-local',
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || undefined,
    dockerBinary: process.env.DOCKER_BINARY || 'docker',
    flushIntervalMs: intFromEnv('LAYER_ZERO_FLUSH_INTERVAL_MS', 500, 50),
    restartDelayMs: intFromEnv('LAYER_ZERO_RESTART_DELAY_MS', 3000, 100),
    observerIntervalMs: intFromEnv('LAYER_ZERO_OBSERVER_INTERVAL_MS', 5000, 500),
    logLevel: logLevelFromEnv(),
  };
}
