import { GuardedActionService } from './action-service.js';
import { loadConfig } from './config.js';
import { DockerExecFileRunner } from './docker-runner.js';
import { EnableInterfaceExecutor } from './enable-interface-executor.js';
import { initFirestore } from './firebase.js';
import { FirestoreActionRepository } from './firestore-repository.js';
import { ProposalWatcher } from './proposal-watcher.js';
import { createNetworkControllerServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = (message: string): void =>
    console.log(`[${new Date().toTimeString().slice(0, 8)}] ${message}`);
  log('ACN Network Controller starting (localhost, human approval required)');
  const db = initFirestore(config);
  const repository = new FirestoreActionRepository(db);
  const executor = new EnableInterfaceExecutor(db, new DockerExecFileRunner(), config);
  const service = new GuardedActionService(repository, executor);
  const watcher = new ProposalWatcher(db, service, log);
  const server = createNetworkControllerServer(config, service);
  watcher.start();
  await service.resumeApproved();
  log(`Approval API: http://${config.host}:${config.port}`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`Received ${signal} - shutting down`);
    server.close();
    await watcher.stop();
    log('Network Controller stopped');
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((error: unknown) => {
  console.error('Fatal Network Controller startup error:', error);
  process.exit(1);
});
