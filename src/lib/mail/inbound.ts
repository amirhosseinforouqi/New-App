/**
 * Inbound email → client profile.
 *
 * Watches the broker's own mailbox over IMAP. A message from an address with
 * no client profile creates one; a message from a known client is appended to
 * their portal thread so the conversation stays in one place regardless of
 * whether they wrote from email or the portal.
 *
 * Safety properties:
 *  - Every message is recorded in `inbound_emails` keyed on the RFC Message-ID
 *    BEFORE any action is taken, so a redelivery is a no-op.
 *  - Automated senders are filtered (INBOUND_IGNORE_LIST plus standard
 *    auto-submitted headers). Without this, a single vacation autoresponder
 *    loop creates client profiles for your own mail server.
 *  - Processed messages are moved to a separate folder, so the inbox stays a
 *    human's inbox.
 */

import { simpleParser, type ParsedMail } from 'mailparser';
import { eq, sql } from 'drizzle-orm';

import { asSystem } from '@/db';
import { clients, inboundEmails, messages } from '@/db/schema';
import { imapConfig } from '@/lib/env';
import { createClientProfile, nameFromEmail } from '@/lib/onboarding';

export type InboundOutcome =
  | 'client_created'
  | 'message_appended'
  | 'ignored_sender'
  | 'ignored_automated'
  | 'duplicate'
  | 'error';

export interface InboundResult {
  outcome: InboundOutcome;
  clientId?: string;
  detail?: string;
}

/** Automated-mail heuristics, checked before anything creates a profile. */
function isAutomated(mail: ParsedMail): boolean {
  const headers = mail.headers;

  if (headers.has('auto-submitted')) {
    const value = String(headers.get('auto-submitted')).toLowerCase();
    if (value !== 'no') return true;
  }
  if (headers.has('list-unsubscribe') || headers.has('list-id')) return true;
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return true;

  const precedence = headers.get('precedence');
  if (precedence && ['bulk', 'junk', 'list'].includes(String(precedence).toLowerCase())) {
    return true;
  }

  const subject = (mail.subject ?? '').toLowerCase();
  return (
    subject.startsWith('auto:') ||
    subject.includes('out of office') ||
    subject.includes('automatic reply') ||
    subject.includes('undeliverable')
  );
}

function isIgnoredSender(address: string, ignoreList: string[]): boolean {
  const lower = address.toLowerCase();
  return ignoreList.some((entry) => lower.includes(entry));
}

/** Cut quoted replies and signatures down to something readable in the thread. */
function extractBody(mail: ParsedMail): string {
  const raw = (mail.text ?? '').trim();
  if (!raw) return '(no text content)';

  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^>/.test(line)) break;
    if (/^On .* wrote:$/.test(line.trim())) break;
    if (/^-{2,}\s*$/.test(line.trim())) break;
    if (/^_{5,}$/.test(line.trim())) break;
    lines.push(line);
  }

  const trimmed = lines.join('\n').trim() || raw;
  return trimmed.slice(0, 5000);
}

/**
 * Process one parsed message.
 *
 * Returns an outcome rather than throwing so the worker can record every
 * message's fate and keep going. One malformed email must not stop the queue.
 */
export async function processInboundMessage(
  mail: ParsedMail,
  brokerName: string,
): Promise<InboundResult> {
  const config = imapConfig();

  const from = mail.from?.value?.[0];
  const fromEmail = from?.address?.toLowerCase();
  const fromName = from?.name?.trim() || '';

  if (!fromEmail) {
    return { outcome: 'error', detail: 'Message has no usable From address.' };
  }

  // Message-ID is the dedupe key. Synthesise one if the sender omitted it —
  // rare, but a missing key would otherwise let every poll reprocess it.
  const messageId =
    mail.messageId ??
    `synthetic:${fromEmail}:${mail.date?.toISOString() ?? ''}:${mail.subject ?? ''}`;

  const alreadySeen = await asSystem(async (db) => {
    const [row] = await db
      .select({ id: inboundEmails.id })
      .from(inboundEmails)
      .where(eq(inboundEmails.messageId, messageId))
      .limit(1);
    return Boolean(row);
  });

  if (alreadySeen) return { outcome: 'duplicate' };

  const body = extractBody(mail);

  const record = async (outcome: InboundOutcome, clientId: string | null) => {
    await asSystem(async (db) => {
      await db
        .insert(inboundEmails)
        .values({
          messageId,
          fromEmail,
          fromName: fromName || null,
          subject: mail.subject ?? null,
          bodyPreview: body.slice(0, 500),
          clientId,
          outcome,
          receivedAt: mail.date ?? new Date(),
          processedAt: new Date(),
        })
        .onConflictDoNothing({ target: inboundEmails.messageId });
    });
  };

  if (isIgnoredSender(fromEmail, config.ignoreList)) {
    await record('ignored_sender', null);
    return { outcome: 'ignored_sender' };
  }

  if (isAutomated(mail)) {
    await record('ignored_automated', null);
    return { outcome: 'ignored_automated' };
  }

  // Never onboard the broker's own mailbox from its own sent mail.
  if (fromEmail === config.user.toLowerCase()) {
    await record('ignored_sender', null);
    return { outcome: 'ignored_sender' };
  }

  const existing = await asSystem(async (db) => {
    const [row] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(sql`lower(${clients.email}) = ${fromEmail}`)
      .limit(1);
    return row;
  });

  // ── Known client: append to their thread ─────────────────────────────────
  if (existing) {
    await asSystem(async (db) => {
      await db.insert(messages).values({
        clientId: existing.id,
        senderType: 'client',
        senderId: existing.id,
        body: mail.subject ? `**${mail.subject}**\n\n${body}` : body,
      });
    });

    await record('message_appended', existing.id);
    return { outcome: 'message_appended', clientId: existing.id };
  }

  // ── New enquiry: create the profile ──────────────────────────────────────
  try {
    const result = await createClientProfile(
      {
        email: fromEmail,
        fullName: fromName || nameFromEmail(fromEmail),
        source: 'inbound_email',
        notes: mail.subject ? `Initial enquiry: ${mail.subject}` : undefined,
      },
      brokerName,
    );

    // Keep the original enquiry as the first message in the thread, so the
    // broker opens the file and immediately sees what was asked.
    await asSystem(async (db) => {
      await db.insert(messages).values({
        clientId: result.clientId,
        senderType: 'client',
        senderId: result.clientId,
        body: mail.subject ? `**${mail.subject}**\n\n${body}` : body,
      });
    });

    await record('client_created', result.clientId);

    return {
      outcome: 'client_created',
      clientId: result.clientId,
      detail: result.warnings.join(' '),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await record('error', null);
    return { outcome: 'error', detail };
  }
}

export { simpleParser };
