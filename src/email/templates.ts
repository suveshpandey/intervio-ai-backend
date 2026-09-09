import { env } from '@/config/env';

/** Email palette — mirrors the app's deep-navy theme (inline styles for mail clients). */
const C = {
  bg: '#00111c',
  card: '#001523',
  border: '#0f3049',
  text: '#f2f4ff',
  muted: '#93a9bf',
  accent: '#a9d3ff',
  accentText: '#00111c',
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface EmailBody {
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  note?: string;
}

function render(preheader: string, b: EmailBody): string {
  const paras = b.paragraphs
    .map(
      (t) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${C.muted};">${t}</p>`,
    )
    .join('');

  const button = b.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 6px;">
         <tr><td style="border-radius:8px;background:${C.accent};">
           <a href="${b.cta.url}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:${C.accentText};text-decoration:none;border-radius:8px;">${b.cta.label}</a>
         </td></tr>
       </table>`
    : '';

  const note = b.note
    ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:${C.muted};">${b.note}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
</head>
<body style="margin:0;background:${C.bg};padding:32px 16px;font-family:${FONT};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${C.card};border:1px solid ${C.border};border-radius:16px;overflow:hidden;">
    <tr><td style="padding:28px 32px 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="${env.APP_URL}/logo.png" width="28" height="28" alt="Intervio" style="display:block;border-radius:7px;"></td>
        <td style="vertical-align:middle;padding-left:10px;font-size:15px;font-weight:600;letter-spacing:-0.01em;color:${C.text};">Intervio<span style="color:${C.muted};">.ai</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 32px 8px;">
      <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.02em;color:${C.text};">${b.heading}</h1>
      ${paras}${button}${note}
    </td></tr>
    <tr><td style="padding:22px 32px 26px;">
      <div style="border-top:1px solid ${C.border};padding-top:18px;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:${C.muted};">Go beyond the resume. — Intervio.ai</p>
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body>
</html>`;
}

export function welcomeEmail(name?: string) {
  const heading = name ? `Welcome, ${escapeHtml(name)}` : 'Welcome to Intervio.ai';
  return {
    subject: 'Welcome to Intervio.ai',
    html: render('Turn your resume into a live interview.', {
      heading,
      paragraphs: [
        `You're in. Intervio turns your resume into a live voice interview — it pulls out the claims worth defending, probes them, and tells you how ready you really are.`,
        `Upload a resume to see the claims we'd challenge, then run your first interview.`,
      ],
      cta: { label: 'Analyze a resume', url: `${env.APP_URL}/new` },
    }),
    text: `Welcome to Intervio.ai${name ? `, ${name}` : ''}!\n\nIntervio turns your resume into a live voice interview — it extracts the claims worth defending, probes them, and tells you how ready you are.\n\nGet started: ${env.APP_URL}/new\n\n— Intervio.ai`,
  };
}

export function resetPasswordEmail(resetUrl: string, name?: string) {
  return {
    subject: 'Reset your Intervio.ai password',
    html: render('Reset your Intervio.ai password.', {
      heading: 'Reset your password',
      paragraphs: [
        `We got a request to reset the password for your Intervio account${name ? `, ${escapeHtml(name)}` : ''}.`,
        `Click the button below to choose a new one. This link expires in 60 minutes.`,
      ],
      cta: { label: 'Reset password', url: resetUrl },
      note: `If you didn't request this, you can safely ignore this email — your password won't change.`,
    }),
    text: `Reset your Intervio.ai password\n\nWe got a request to reset your password. Open this link to choose a new one (expires in 60 minutes):\n\n${resetUrl}\n\nIf you didn't request this, ignore this email — your password won't change.\n\n— Intervio.ai`,
  };
}
