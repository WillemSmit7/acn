import { loadConfig } from './config/env.js';
import { enabledDevices } from './config/devices.js';
import { createLogger } from './logger.js';
import { initFirestore } from './firebase/client.js';
import { AcnRepository } from './firebase/repository.js';
import { HealthService } from './service.js';

/**
 * ACN Health Service entrypoint.
 *
 * Pass --once to run a single check round and exit (used by the end-to-end
 * test script); otherwise the service runs the periodic loop until signalled.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('ACN Health Service starting');

  const devices = enabledDevices();
  if (devices.length === 0) {
    logger.error('No enabled devices configured - nothing to monitor');
    process.exitCode = 1;
    return;
  }

  const firestore = initFirestore(config, logger);
  const repository = new AcnRepository(firestore, logger);

  try {
    await repository.syncDevices(devices);
  } catch (error) {
    // Not fatal: monitoring is more important than the device inventory.
    logger.error(
      `Could not sync devices to Firestore: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const service = new HealthService(devices, config, repository, logger);

  if (process.argv.includes('--once')) {
    await service.runOnce();
    return;
  }

  await service.start();

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal} - shutting down`);
    service.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
