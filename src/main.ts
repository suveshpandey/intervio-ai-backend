import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, corsOrigins } from '@/config/env';
import { logger } from '@/common/logger';
import { errorHandler, notFoundHandler } from '@/common/http';
import { prisma } from '@/db/prisma';
import { redis } from '@/db/redis';
import { authRouter } from '@/auth/auth.routes';

const app = express();

app.set('trust proxy', 1); // behind a load balancer in prod (correct secure-cookie handling)
app.use(helmet());
app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));

app.get('/health', async (_req, res) => {
  const [db, cache] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);
  const ok = db.status === 'fulfilled' && cache.status === 'fulfilled';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    db: db.status === 'fulfilled',
    redis: cache.status === 'fulfilled',
  });
});

app.use('/auth', authRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info(`🚀 intervio-backend listening on :${env.PORT} (${env.NODE_ENV})`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down`);
  server.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
