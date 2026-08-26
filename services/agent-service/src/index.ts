import { loadConfig } from './config/env.js';
import { initFirestore } from './firebase/client.js';
import { AgentRepository } from './firebase/repository.js';
import { createLogger } from './logger.js';
import { OpenAIInvestigatorClient } from './openai/client.js';
import { AgentService } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info('ACN Agent Service starting (strictly read-only investigator)');
  if (config.openAIApiKey === undefined) {
    logger.warn('OPENAI_API_KEY is not configured; investigations will be recorded as failed');
  }

  const firestore = initFirestore(config, logger);
  const repository = new AgentRepository(firestore, logger);
  const client = new OpenAIInvestigatorClient(config);
  const service = new AgentService(config, repository, client, logger);
  service.start();

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
  console.error('Fatal error during Agent Service startup:', error);
  process.exit(1);
});
