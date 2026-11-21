import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { connectDatabase, disconnectDatabase } from './db/prisma.js';

try {
  await connectDatabase();
} catch (error) {
  logger.fatal({ err: error }, 'database connection failed');
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ host: config.HOST, port: config.PORT }, 'server listening');
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    try {
      await disconnectDatabase();
    } catch (error) {
      logger.error({ err: error }, 'database disconnect failed');
    }
    logger.info('server closed');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
