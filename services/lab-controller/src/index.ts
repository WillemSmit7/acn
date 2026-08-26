import { loadConfig } from './config.js';
import { LabActionService } from './action-service.js';
import { ProcessScenarioRunner } from './process-runner.js';
import { ActionRepository, initFirestore } from './repository.js';
import { createControllerServer } from './server.js';

const config = loadConfig();
const clock = (): string => new Date().toTimeString().slice(0, 8);
const log = (message: string): void => console.log(`[${clock()}] ${message}`);

log('ACN Lab Controller starting (localhost, whitelisted scenarios only)');
log(`Firestore: emulator at ${config.emulatorHost} (project ${config.projectId})`);

const repository = new ActionRepository(initFirestore(config));
const service = new LabActionService(repository, new ProcessScenarioRunner(), log);
const server = createControllerServer(config, service);
log(`Operator API: http://${config.host}:${config.port}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`Received ${signal} - shutting down`);
  server.close();
  await service.stop();
  log('Lab Controller stopped');
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
