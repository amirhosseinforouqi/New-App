/**
 * Outbound mail over SMTP.
 *
 * Sends from the broker's own mailbox on their own domain, so clients see mail
 * from a person they recognise rather than a service address. With Google
 * Workspace this means smtp.gmail.com:465 and an App Password — a normal
 * account password will be rejected once 2FA is on.
 *
 * Deliverability note: because we authenticate as the mailbox owner, SPF and
 * DKIM already pass for the domain. Do not "improve" this by switching the
 * From address to a different domain than SMTP_USER — that is exactly what
 * lands credential emails in spam.
 */

import nodemailer, { type Transporter } from 'nodemailer';

import { smtpConfig } from '@/lib/env';
import type { EmailBody } from './templates';

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const config = smtpConfig();
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    // Modest pooling: credential and notification mail is bursty at low volume.
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
  });

  return transporter;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send a rendered email.
 *
 * Returns a result object rather than throwing. Callers are almost always in
 * the middle of something more important than the email — creating a client,
 * advancing a stage — and a transient SMTP failure must not roll that back.
 * The failure is surfaced to the broker in the UI and the action can be
 * retried from there.
 */
export async function sendEmail(to: string, body: EmailBody): Promise<SendResult> {
  try {
    // Inside the try deliberately: reading the config throws when SMTP is not
    // configured, and that must arrive as a failed result like any other send
    // failure. Outside, it escapes and takes the caller down with it — which is
    // how a client ends up created but with no file attached to them.
    const config = smtpConfig();

    const info = await getTransporter().sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      to,
      replyTo: config.replyTo || config.fromAddress,
      subject: body.subject,
      text: body.text,
      html: body.html,
    });

    return { ok: true, messageId: info.messageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[mail] send failed', { to, subject: body.subject, error: message });
    return { ok: false, error: message };
  }
}

/** Used by the health endpoint to prove SMTP credentials work. */
export async function verifySmtp(): Promise<{ ok: boolean; detail: string }> {
  try {
    await getTransporter().verify();
    return { ok: true, detail: 'SMTP connection and credentials accepted.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail:
        `${message}. For Google Workspace, confirm you are using an App Password ` +
        'rather than the account password, and that IMAP/SMTP access is enabled.',
    };
  }
}
