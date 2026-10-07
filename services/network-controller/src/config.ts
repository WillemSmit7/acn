import 'dotenv/config';

export interface NetworkControllerConfig {
  host: '127.0.0.1' | 'localhost';
  port: number;
  projectId: string;
  emulatorHost: string;
  commandTimeoutMs: number;
  verificationTimeoutMs: number;
  verificationPollMs: number;
}

export function loadConfig(): NetworkControllerConfig {
  const host = process.env.NETWORK_CONTROLLER_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('NETWORK_CONTROLLER_HOST must be loopback');
  }
  return {
    host,
    port: integer('NETWORK_CONTROLLER_PORT', 8788, 1, 65_535),
    projectId: process.env.FIREBASE_PROJECT_ID ?? 'acn-local',
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
    commandTimeoutMs: integer('NETWORK_ACTION_TIMEOUT_MS', 10_000, 500, 60_000),
    verificationTimeoutMs: integer('NETWORK_VERIFY_TIMEOUT_MS', 45_000, 1_000, 300_000),
    verificationPollMs: integer('NETWORK_VERIFY_POLL_MS', 1_000, 100, 10_000),
  };
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
