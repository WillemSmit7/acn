import { loadConfig } from './config/env.js';
import { logSources } from './config/sources.js';
import { createLogger } from './logger.js';
import { initFirestore } from './firebase/client.js';
import { LayerZeroRepository } from './firebase/repository.js';
import { LayerZeroPipeline } from './pipeline.js';
import { DockerStateProbe } from './observer/dockerStateProbe.js';
import { AutonomousStateObserver } from './observer/stateObserver.js';

/**
 * ACN Layer 0 entrypoint.
 *
 * Streams FRR logs and independently inspects intended router state, stores
 * exact evidence in networkLogs/, and writes normalized transition events.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('ACN Layer 0 starting');

  const firestore = initFirestore(config, logger);
  const repository = new LayerZeroRepository(firestore, logger);
  const pipeline = new LayerZeroPipeline(logSources, config, repository, logger);
  const observer = new AutonomousStateObserver(
    new DockerStateProbe(config.dockerBinary, (message) => logger.warn(message)),
    config.observerIntervalMs,
    (observation) => pipeline.handleObservation(observation),
    logger,
  );

  pipeline.start();
  observer.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} - shutting down`);
    observer.stop();
    // Drain the buffer before exiting, so events collected in the final
    // interval are not lost on a clean stop.
    void pipeline.stop().then(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
