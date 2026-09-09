import nodemailer, { type Transporter } from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { env, emailTransport, isProd } from '@/config/env';
import { logger } from '@/common/logger';

// AWS SES, via whichever transport is configured (SMTP creds win, else the SES API).
let smtp: Transporter | null = null;
function smtpTransport(): Transporter {
  if (!smtp) {
    smtp = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return smtp;
}

const ses =
  emailTransport === 'ses'
    ? new SESv2Client({
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
        },
      })
    : null;

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Boot-time credential check. SMTP is verified live; the SES API validates on first send. */
export async function verifyTransport(): Promise<boolean> {
  if (!emailTransport) return false;
  if (emailTransport === 'smtp') {
    try {
      await smtpTransport().verify();
      return true;
    } catch (err) {
      logger.error({ err }, 'SMTP transport verify failed');
      return false;
    }
  }
  return true;
}

/**
 * Send an email via SES (SMTP or API). Best-effort: never throws — returns whether
 * it was sent, so a mail failure can never break a signup or reset flow.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!emailTransport) {
    logger.warn(
      { to: mail.to, subject: mail.subject },
      'Email disabled (no EMAIL_FROM + transport) — skipping send',
    );
    // In dev, surface the intended content so flows can still be tested end-to-end.
    if (!isProd) logger.info({ to: mail.to, subject: mail.subject }, mail.text);
    return false;
  }

  const from = `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`;
  const listUnsubscribe = `<mailto:${env.EMAIL_FROM}?subject=unsubscribe>`;

  try {
    if (emailTransport === 'smtp') {
      await smtpTransport().sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: { 'List-Unsubscribe': listUnsubscribe },
      });
    } else {
      await ses!.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [mail.to] },
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: mail.html, Charset: 'UTF-8' },
                Text: { Data: mail.text, Charset: 'UTF-8' },
              },
              Headers: [{ Name: 'List-Unsubscribe', Value: listUnsubscribe }],
            },
          },
        }),
      );
    }
    logger.info({ to: mail.to, subject: mail.subject, via: emailTransport }, 'Email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: mail.to, subject: mail.subject }, 'Email send failed');
    return false;
  }
}
