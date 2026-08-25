import 'dotenv/config';

/** Runtime configuration, resolved once at startup from the environment. */
export interface AppConfig {
  projectId: string;
  /** Set when the service targets the Firestore emulator instead of production. */
  emulatorHost: string | undefined;
  /** How long an incident stays open to absorb related events. */
  correlationWindowMs: number;
  /** Quiet period before a root cause is treated as settled. */
  settleMs: number;
  /** How often incidents are re-evaluated and flushed. */
  tickIntervalMs: number;
  /**
   * Correlate events already in Firestore rather than starting from now.
   * Off by default: like the Health Service's baseline and Layer 0's tail, the
   * service observes from the moment it starts. The end-to-end test turns it on
   * so a run can be asserted after the fact.
   */
  replayHistory: boolean;
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

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
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
    correlationWindowMs: intFromEnv('INCIDENT_CORRELATION_WINDOW_MS', 120_000, 1_000),
    settleMs: intFromEnv('INCIDENT_SETTLE_MS', 10_000, 500),
    tickIntervalMs: intFromEnv('INCIDENT_TICK_INTERVAL_MS', 2_000, 250),
    replayHistory: boolFromEnv('INCIDENT_REPLAY_HISTORY', false),
    logLevel: logLevelFromEnv(),
  };
}
