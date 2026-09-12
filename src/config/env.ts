import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  COOKIE_DOMAIN: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  OAUTH_SUCCESS_REDIRECT: z.string().url().default('http://localhost:3000/dashboard'),

  AWS_REGION: z.string().default('ap-south-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('intervio-resumes'),

  EURI_API_KEY: z.string().optional(),
  EURI_BASE_URL: z.string().url().default('https://api.euron.one/api/v1/euri'),

  // Email — sent via AWS SES. Two supported transports (auto-selected):
  //  • SMTP: set SMTP_USER / SMTP_PASS to your SES SMTP credentials, or
  //  • SES API: uses SES_* keys if set (dedicated SES IAM user), else the AWS_* keys.
  EMAIL_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SMTP_HOST: z.string().default('email-smtp.ap-south-1.amazonaws.com'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Dedicated SES IAM user (optional) — if set, the SES API path uses these instead
  // of AWS_*. Region falls back to AWS_REGION when SES_REGION is absent.
  SES_ACCESS_KEY_ID: z.string().optional(),
  SES_SECRET_ACCESS_KEY: z.string().optional(),
  SES_REGION: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(), // must be an SES-verified sender identity
  EMAIL_FROM_NAME: z.string().default('Intervio.ai'),

  // Voice (Deepgram) — STT + TTS for the live interview.
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_STT_MODEL: z.string().default('nova-3'),
  DEEPGRAM_TTS_MODEL: z.string().default('aura-2-thalia-en'),

  // Public base URL of the frontend — used to build links in emails.
  APP_URL: z.string().url().default('http://localhost:3000'),
});

// Treat empty-string env vars (common in .env files) as absent so optional fields validate.
const cleaned = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
);

const parsed = schema.safeParse(cleaned);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';

/** Origins allowed to make credentialed browser requests. */
export const corsOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim());

/** True once Google OAuth is fully configured. */
export const googleOAuthEnabled = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI,
);

/** True once S3 credentials are present. */
export const s3Enabled = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);

/** True once the Deepgram key is present (voice interviews enabled). */
export const voiceEnabled = Boolean(env.DEEPGRAM_API_KEY);

/** True once the euri LLM gateway key is present. */
export const llmEnabled = Boolean(env.EURI_API_KEY);

/** Resolved SES API credentials + region: dedicated SES_* keys win, else the shared AWS_*. */
export const sesConfig = {
  region: env.SES_REGION ?? env.AWS_REGION,
  accessKeyId: env.SES_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.SES_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
};

/** Which SES transport to use: SMTP creds win, else the SES API (SES_* or AWS_* keys). */
export const emailTransport: 'smtp' | 'ses' | null =
  env.EMAIL_ENABLED && env.EMAIL_FROM
    ? env.SMTP_USER && env.SMTP_PASS
      ? 'smtp'
      : sesConfig.accessKeyId && sesConfig.secretAccessKey
        ? 'ses'
        : null
    : null;

/** True once a verified sender + a usable transport (SMTP or SES API) are configured. */
export const emailEnabled = emailTransport !== null;
