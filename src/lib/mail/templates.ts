/**
 * Transactional email bodies.
 *
 * Plain, professional, no marketing chrome — these are sent from a broker's
 * own mailbox on their own domain, and anything that looks like a bulk
 * template both erodes trust and hurts deliverability.
 *
 * Every template returns text and HTML. Text-only clients are still common in
 * finance, and a multipart message is treated far better by spam filters than
 * an HTML-only one.
 */

import { env } from '@/lib/env';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e6ea;">
        <tr><td style="padding:32px 32px 8px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1f2b;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:16px 32px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#8a929e;border-top:1px solid #eef0f3;">
          This message was sent by ${escapeHtml(env.appName)}. It contains information about your
          mortgage application — please do not forward it.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const P = 'margin:0 0 16px 0;font-size:15px;line-height:24px;';

export interface EmailBody {
  subject: string;
  text: string;
  html: string;
}

/**
 * Credentials email.
 *
 * The password is in the email body. That is a real, considered trade-off:
 * the alternative (a magic link) means the client has no durable credential
 * and must return to their inbox every visit. It is mitigated by forcing a
 * password change on first login, so the emailed value is single-use in
 * practice. If you would rather not send passwords at all, see the note in
 * docs/ARCHITECTURE.md § Onboarding for the token-link variant.
 */
export function welcomeEmail(params: {
  fullName: string;
  username: string;
  password: string;
  brokerName: string;
}): EmailBody {
  const loginUrl = `${env.appUrl}/login`;
  const firstName = params.fullName.trim().split(/\s+/)[0] ?? params.fullName;

  const text = `Hi ${firstName},

Thanks for getting in touch. I've set up your secure client portal, where you can
upload your documents, message me directly, and follow your application from
start to finish.

Sign in here: ${loginUrl}

  Username: ${params.username}
  Temporary password: ${params.password}

You'll be asked to choose your own password the first time you sign in.

Everything you upload goes straight into your own private folder — only you and
I can see it.

If you have any questions, just reply to this email or send me a message in the
portal.

${params.brokerName}`;

  const html = layout(`
    <p style="${P}">Hi ${escapeHtml(firstName)},</p>
    <p style="${P}">
      Thanks for getting in touch. I've set up your secure client portal, where you can
      upload your documents, message me directly, and follow your application from
      start to finish.
    </p>
    <p style="margin:0 0 24px 0;">
      <a href="${loginUrl}" style="display:inline-block;background:#1a1f2b;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Sign in to your portal</a>
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f7f8fa;border:1px solid #e3e6ea;border-radius:8px;margin:0 0 16px 0;">
      <tr><td style="padding:16px 20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;line-height:24px;color:#1a1f2b;">
        Username: <strong>${escapeHtml(params.username)}</strong><br>
        Temporary password: <strong>${escapeHtml(params.password)}</strong>
      </td></tr>
    </table>
    <p style="${P}">You'll be asked to choose your own password the first time you sign in.</p>
    <p style="${P}">
      Everything you upload goes straight into your own private folder — only you and I can see it.
    </p>
    <p style="${P}">
      If you have any questions, just reply to this email or send me a message in the portal.
    </p>
    <p style="${P}">${escapeHtml(params.brokerName)}</p>
  `);

  return { subject: `Your ${env.appName} login details`, text, html };
}

/** Sent when the broker advances the client's stage. */
export function stageChangeEmail(params: {
  fullName: string;
  stageLabel: string;
  stageDescription: string;
  note?: string;
  brokerName: string;
}): EmailBody {
  const firstName = params.fullName.trim().split(/\s+/)[0] ?? params.fullName;
  const notePart = params.note ? `\n\n${params.note}` : '';

  const text = `Hi ${firstName},

Your application has moved to: ${params.stageLabel}

${params.stageDescription}${notePart}

You can see the full timeline in your portal: ${env.appUrl}/dashboard

${params.brokerName}`;

  const html = layout(`
    <p style="${P}">Hi ${escapeHtml(firstName)},</p>
    <p style="${P}">Your application has moved to:</p>
    <p style="margin:0 0 16px 0;font-size:20px;font-weight:600;color:#1a1f2b;">${escapeHtml(params.stageLabel)}</p>
    <p style="${P}">${escapeHtml(params.stageDescription)}</p>
    ${params.note ? `<p style="${P}">${escapeHtml(params.note)}</p>` : ''}
    <p style="margin:0 0 24px 0;">
      <a href="${env.appUrl}/dashboard" style="display:inline-block;background:#1a1f2b;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">View your timeline</a>
    </p>
    <p style="${P}">${escapeHtml(params.brokerName)}</p>
  `);

  return { subject: `Your application: ${params.stageLabel}`, text, html };
}

/** Sent when the broker requests documents or flags one as needing attention. */
export function documentsRequestedEmail(params: {
  fullName: string;
  items: string[];
  brokerName: string;
}): EmailBody {
  const firstName = params.fullName.trim().split(/\s+/)[0] ?? params.fullName;
  const list = params.items.map((item) => `  • ${item}`).join('\n');

  const text = `Hi ${firstName},

When you have a moment, could you upload the following to your portal?

${list}

Upload here: ${env.appUrl}/dashboard

${params.brokerName}`;

  const html = layout(`
    <p style="${P}">Hi ${escapeHtml(firstName)},</p>
    <p style="${P}">When you have a moment, could you upload the following to your portal?</p>
    <ul style="margin:0 0 20px 0;padding-left:20px;font-size:15px;line-height:26px;color:#1a1f2b;">
      ${params.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
    </ul>
    <p style="margin:0 0 24px 0;">
      <a href="${env.appUrl}/dashboard" style="display:inline-block;background:#1a1f2b;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Upload documents</a>
    </p>
    <p style="${P}">${escapeHtml(params.brokerName)}</p>
  `);

  return { subject: 'A few documents needed for your application', text, html };
}

/** Sent to the client when the broker replies in the portal thread. */
export function newMessageEmail(params: {
  fullName: string;
  preview: string;
  brokerName: string;
}): EmailBody {
  const firstName = params.fullName.trim().split(/\s+/)[0] ?? params.fullName;

  const text = `Hi ${firstName},

You have a new message in your portal:

  "${params.preview}"

Reply here: ${env.appUrl}/dashboard

${params.brokerName}`;

  const html = layout(`
    <p style="${P}">Hi ${escapeHtml(firstName)},</p>
    <p style="${P}">You have a new message in your portal:</p>
    <blockquote style="margin:0 0 20px 0;padding:12px 16px;border-left:3px solid #d5d9e0;background:#f7f8fa;font-size:15px;line-height:24px;color:#41485a;">
      ${escapeHtml(params.preview)}
    </blockquote>
    <p style="margin:0 0 24px 0;">
      <a href="${env.appUrl}/dashboard" style="display:inline-block;background:#1a1f2b;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">Read and reply</a>
    </p>
    <p style="${P}">${escapeHtml(params.brokerName)}</p>
  `);

  return { subject: 'New message about your mortgage application', text, html };
}
