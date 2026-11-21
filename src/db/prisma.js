import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

export const prisma = new PrismaClient({
  datasources: { db: { url: config.DATABASE_URL } },
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

prisma.$on('warn', (event) => {
  logger.warn({ prisma: event }, 'prisma warning');
});

prisma.$on('error', (event) => {
  logger.error({ prisma: event }, 'prisma error');
});

export async function connectDatabase() {
  await prisma.$connect();
  logger.info('database connected');
}

export async function disconnectDatabase() {
  await prisma.$disconnect();
  logger.info('database disconnected');
}

export async function checkDatabase() {
  return prisma.$queryRaw`SELECT 1`;
}
