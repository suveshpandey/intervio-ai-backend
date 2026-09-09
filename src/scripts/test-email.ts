/**
 * Verify the email transport and send a real test message.
 *   npm run email:test -- you@example.com "Your Name"
 */
import { verifyTransport, sendMail } from '@/email/mailer';
import { welcomeEmail } from '@/email/templates';
import { emailTransport } from '@/config/env';
import { logger } from '@/common/logger';

async function main() {
  const to = process.argv[2];
  const name = process.argv[3];

  if (!to) {
    console.error('Usage: npm run email:test -- <to-address> [name]');
    process.exit(1);
  }

  logger.info({ via: emailTransport }, 'Verifying email transport…');
  const ok = await verifyTransport();
  if (!ok) {
    logger.error('Transport not ready — check EMAIL_FROM + SMTP creds / AWS keys.');
    process.exit(1);
  }

  const sent = await sendMail({ to, ...welcomeEmail(name) });
  logger.info({ sent, to }, sent ? 'Test email sent ✅' : 'Test email failed ❌');
  process.exit(sent ? 0 : 1);
}

void main();
