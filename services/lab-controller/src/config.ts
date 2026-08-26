import 'dotenv/config';

export interface ControllerConfig {
  host: string;
  port: number;
  projectId: string;
  emulatorHost: string;
}

export function loadConfig(): ControllerConfig {
  const rawPort = process.env.LAB_CONTROLLER_PORT ?? '8787';
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid LAB_CONTROLLER_PORT="${rawPort}"`);
  }

  return {
    host: process.env.LAB_CONTROLLER_HOST ?? '127.0.0.1',
    port,
    projectId: process.env.FIREBASE_PROJECT_ID ?? 'acn-local',
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
  };
}
