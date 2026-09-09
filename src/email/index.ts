import { sendMail } from '@/email/mailer';
import { welcomeEmail, resetPasswordEmail } from '@/email/templates';

/** Best-effort — returns whether the mail was sent. Never throws. */
export async function sendWelcomeEmail(to: string, name?: string): Promise<boolean> {
  return sendMail({ to, ...welcomeEmail(name) });
}

/** Best-effort — returns whether the mail was sent. Never throws. */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
  name?: string,
): Promise<boolean> {
  return sendMail({ to, ...resetPasswordEmail(resetUrl, name) });
}
