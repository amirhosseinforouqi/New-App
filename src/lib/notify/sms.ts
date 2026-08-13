/**
 * Outbound SMS.
 *
 * There is no Twilio account configured, and this module does not pretend
 * otherwise. Without credentials `sendSms` returns `{ ok: false, reason:
 * 'not_configured' }` and callers fall back to email — they do not throw, and
 * nothing anywhere logs a message as "sent" that was not.
 *
 * That distinction is the whole point of this file. A reminder system that
 * silently drops SMS while showing "reminder sent" in the broker's UI is worse
 * than one with no SMS at all: the broker stops chasing a client who never
 * heard from them.
 *
 * Wiring a real account is three environment variables and no code change.
 * The Twilio REST call below is the actual documented one — it is exercised the
 * moment TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER exist.
 */

import { optional } from '@/lib/env';

export interface SmsResult {
  ok: boolean;
  messageId?: string;
  reason?: 'not_configured' | 'invalid_number' | 'send_failed';
  error?: string;
}

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export function smsConfig(): SmsConfig | null {
  const accountSid = optional('TWILIO_ACCOUNT_SID');
  const authToken = optional('TWILIO_AUTH_TOKEN');
  const fromNumber = optional('TWILIO_FROM_NUMBER');

  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

export function isSmsConfigured(): boolean {
  return smsConfig() !== null;
}

/**
 * Normalise a Canadian number to E.164.
 *
 * Clients type "(416) 555-0142" and "416-555-0142" and "1 416 555 0142".
 * Twilio takes exactly one of those. Anything that is not a plausible
 * 10-digit NANP number (optionally with a leading 1) is rejected rather than
 * guessed at — sending a mortgage client's document reminder to a wrong number
 * is a privacy incident.
 */
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;

  const digits = input.replace(/\D/g, '');

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  // Already E.164 with a different country code.
  if (input.trim().startsWith('+') && digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const config = smsConfig();
  if (!config) return { ok: false, reason: 'not_configured' };

  const destination = toE164(to);
  if (!destination) {
    return { ok: false, reason: 'invalid_number', error: `Could not read "${to}" as a phone number.` };
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: destination,
          From: config.fromNumber,
          Body: body,
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, reason: 'send_failed', error: `${response.status}: ${detail.slice(0, 200)}` };
    }

    const data = (await response.json()) as { sid?: string };
    return { ok: true, messageId: data.sid };
  } catch (error) {
    return {
      ok: false,
      reason: 'send_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * SMS is a 160-character medium and clients read it on a lock screen. Long
 * bodies get split by the carrier and arrive out of order, so the reminder is
 * built short by construction rather than trimmed after the fact.
 */
export function documentReminderSms(input: {
  firstName: string;
  outstandingCount: number;
  brokerName: string;
  portalUrl: string;
}): string {
  const { firstName, outstandingCount, brokerName, portalUrl } = input;
  const item = outstandingCount === 1 ? 'document' : 'documents';

  return (
    `Hi ${firstName}, ${brokerName} here. You have ${outstandingCount} ${item} still ` +
    `outstanding on your mortgage file. ${portalUrl}`
  );
}
