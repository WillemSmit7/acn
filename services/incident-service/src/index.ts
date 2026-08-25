import { loadConfig } from './config/env.js';
import { createLogger } from './logger.js';
import { initFirestore } from './firebase/client.js';
import { IncidentRepository } from './firebase/repository.js';
import { IncidentService } from './service.js';

/**
 * ACN Incident Service entrypoint.
 *
 * Correlates the normalized event stream into incidents with a probable root
 * cause. Increment 4's agent investigates the incidents this produces.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('ACN Incident Service starting');

  const firestore = initFirestore(config, logger);
  const repository = new IncidentRepository(firestore, logger);
  const service = new IncidentService(config, repository, logger);

  await service.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} - shutting down`);
    void service.stop().then(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
