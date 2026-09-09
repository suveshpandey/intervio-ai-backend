import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, corsOrigins, emailEnabled, emailTransport } from '@/config/env';
import { logger } from '@/common/logger';
import { verifyTransport } from '@/email/mailer';
import { errorHandler, notFoundHandler } from '@/common/http';
import { prisma } from '@/db/prisma';
import { redis } from '@/db/redis';
import { authRouter } from '@/auth/auth.routes';
import { resumeRouter } from '@/modules/resume/resume.routes';
import { jdRouter } from '@/modules/jd/jd.routes';
import { blueprintRouter } from '@/modules/planner/planner.routes';
import { interviewRouter } from '@/modules/interview/interview.routes';
import { startParseWorker } from '@/jobs/parse.worker';

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
app.use('/resumes', resumeRouter);
app.use('/jd', jdRouter);
app.use('/blueprints', blueprintRouter);
app.use('/interviews', interviewRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info(`🚀 intervio-backend listening on :${env.PORT} (${env.NODE_ENV})`);
});

// Non-blocking boot check so misconfigured email surfaces in logs, not at send time.
if (emailEnabled) {
  void verifyTransport().then((ok) =>
    ok
      ? logger.info({ via: emailTransport }, 'Email transport ready')
      : logger.warn({ via: emailTransport }, 'Email transport check failed'),
  );
} else {
  logger.warn('Email disabled — set EMAIL_FROM + SMTP creds (or AWS keys) to enable');
}

// Background worker runs in-process alongside the API for the MVP.
const parseWorker = startParseWorker();

async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down`);
  server.close();
  await Promise.allSettled([parseWorker.close(), prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
