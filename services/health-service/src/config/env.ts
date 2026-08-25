import 'dotenv/config';

/** Runtime configuration, resolved once at startup from the environment. */
export interface AppConfig {
  projectId: string;
  /** Set when the service targets the Firestore emulator instead of production. */
  emulatorHost: string | undefined;
  checkIntervalSeconds: number;
  checkTimeoutSeconds: number;
  pingCount: number;
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
    checkIntervalSeconds: intFromEnv('HEALTH_CHECK_INTERVAL_SECONDS', 30, 1),
    checkTimeoutSeconds: intFromEnv('HEALTH_CHECK_TIMEOUT_SECONDS', 2, 1),
    pingCount: intFromEnv('HEALTH_CHECK_PING_COUNT', 2, 1),
    logLevel: logLevelFromEnv(),
  };
}
