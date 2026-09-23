// Minimal email sender for the Dropped Rework Alert digest (see dropped-alert.js Feature 3).
// Added 2026-09-23 (Shelly's request) - the first feature in this repo that sends actual email
// rather than a Slack alert. Uses nodemailer (the one external dependency in this repo - every
// other lib here deliberately avoids dependencies via built-in fetch/crypto, but rolling MIME
// multipart + inline image attachments by hand over raw SMTP wasn't worth it here) via a shared
// Google Workspace mailbox authenticated with an App Password (Shelly's choice - simplest SMTP
// setup, no OAuth flow).
import nodemailer from 'nodemailer';

const GMAIL_USER = requireEnv('WHOLESALE_ALERTS_GMAIL_USER');
const GMAIL_APP_PASSWORD = requireEnv('WHOLESALE_ALERTS_GMAIL_APP_PASSWORD');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

// `attachments` follows nodemailer's own shape - pass [{ cid, filename, content: Buffer }] for
// images referenced inline in `html` via <img src="cid:...">.
export async function sendEmail({ to, subject, html, attachments }) {
  await transporter.sendMail({
    from: GMAIL_USER,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
    attachments,
  });
}
