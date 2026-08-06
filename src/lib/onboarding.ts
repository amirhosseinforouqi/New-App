/**
 * Client onboarding.
 *
 * The sequence, and why it is ordered this way:
 *
 *   1. Insert the client row (transactional, with username collision retry)
 *   2. Seed stage history at "inquiry"
 *   3. Create their Google Drive folder and store the id
 *   4. Queue the checklist skill
 *   5. Send the credentials email
 *
 * Steps 3–5 happen AFTER the transaction commits, deliberately. Drive and SMTP
 * are third-party calls that can be slow or fail; holding a database
 * transaction open across them is how you get lock contention and half-created
 * clients. If Drive or email fails, the client still exists and the broker can
 * retry those steps from the admin UI — which is a far better failure mode
 * than losing the enquiry entirely.
 */

import { and, eq, sql } from 'drizzle-orm';

import { asSystem, type Db } from '@/db';
import { clients, clientStageHistory, sessions } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { generatePassword, hashPassword } from '@/lib/auth/password';
import { allocateUsername } from '@/lib/auth/username';
import { ensureClientFolder } from '@/lib/drive/service';
import { sendEmail } from '@/lib/mail/smtp';
import { welcomeEmail } from '@/lib/mail/templates';
import { dispatchTrigger } from '@/lib/agent';

export interface CreateClientInput {
  email: string;
  fullName: string;
  applicationType?: string;
  phone?: string;
  notes?: string;
  brokerId?: string | null;
  /** Who initiated this — an inbound email, or a broker in the admin UI. */
  source: 'inbound_email' | 'broker';
}

export interface CreateClientResult {
  clientId: string;
  username: string;
  /** Present only on creation. Never stored, never logged. */
  temporaryPassword: string;
  created: boolean;
  driveFolderId: string | null;
  emailSent: boolean;
  warnings: string[];
}

/** Name guess from an email address, for when the sender gave no display name. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'Client';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

/**
 * Create a client profile, or return the existing one.
 *
 * Idempotent on email: a client who emails three times gets one profile and
 * one set of credentials, not three. This matters because the inbound mail
 * worker is at-least-once by design.
 */
export async function createClientProfile(
  input: CreateClientInput,
  brokerName: string,
): Promise<CreateClientResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim() || nameFromEmail(email);
  const warnings: string[] = [];

  // ── Step 1–2: create the row ───────────────────────────────────────────────
  const created = await asSystem(async (db) => {
    const [existing] = await db
      .select({ id: clients.id, username: clients.username, driveFolderId: clients.driveFolderId })
      .from(clients)
      .where(sql`lower(${clients.email}) = ${email}`)
      .limit(1);

    if (existing) {
      return { ...existing, isNew: false as const, temporaryPassword: '' };
    }

    const temporaryPassword = generatePassword();
    const passwordHash = await hashPassword(temporaryPassword);

    // Retry on username collision: allocateUsername reads then we insert, and
    // two simultaneous onboardings for "J. Smith" can both pick "jsmith".
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const username = await allocateUsername(db, fullName);
      try {
        const [row] = await db
          .insert(clients)
          .values({
            email,
            fullName,
            username,
            passwordHash,
            applicationType: input.applicationType ?? 'purchase',
            phone: input.phone ?? null,
            notes: input.notes ?? null,
            brokerId: input.brokerId ?? null,
            status: 'invited',
            stageKey: 'inquiry',
            mustChangePassword: true,
          })
          .returning({ id: clients.id, username: clients.username });

        if (!row) throw new Error('Insert returned no row.');

        await db.insert(clientStageHistory).values({
          clientId: row.id,
          stageKey: 'inquiry',
          note: input.source === 'inbound_email' ? 'Created from inbound email.' : 'Created by broker.',
        });

        await recordAudit(db, {
          actorType: input.source === 'inbound_email' ? 'system' : 'broker',
          actorId: input.brokerId ?? null,
          action: 'client.created',
          targetType: 'client',
          targetId: row.id,
          clientId: row.id,
          metadata: { source: input.source, applicationType: input.applicationType ?? 'purchase' },
        });

        return {
          id: row.id,
          username: row.username,
          driveFolderId: null,
          isNew: true as const,
          temporaryPassword,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isUsernameCollision = message.includes('clients_username_key');
        if (!isUsernameCollision || attempt === 2) throw error;
        // Loop and re-allocate.
      }
    }

    throw new Error('Could not allocate a unique username after 3 attempts.');
  });

  if (!created.isNew) {
    return {
      clientId: created.id,
      username: created.username,
      temporaryPassword: '',
      created: false,
      driveFolderId: created.driveFolderId,
      emailSent: false,
      warnings: ['A client with this email already exists; no new credentials were issued.'],
    };
  }

  // ── Step 3: Drive folder ───────────────────────────────────────────────────
  let driveFolderId: string | null = null;
  try {
    driveFolderId = await ensureClientFolder(fullName, created.id);
    await asSystem(async (db) => {
      await db
        .update(clients)
        .set({ driveFolderId, updatedAt: new Date() })
        .where(eq(clients.id, created.id));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[onboarding] Drive folder creation failed', { clientId: created.id, message });
    warnings.push(
      `Google Drive folder was not created (${message}). The client exists and can log in, ` +
        'but uploads will fail until you retry folder creation from the admin page.',
    );
  }

  // ── Step 4: trigger the agent ──────────────────────────────────────────────
  try {
    await asSystem(async (db) => {
      await dispatchTrigger(db, 'client.created', {
        clientId: created.id,
        input: {
          clientId: created.id,
          fullName,
          applicationType: input.applicationType ?? 'purchase',
          notes: input.notes,
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[onboarding] agent dispatch failed', { clientId: created.id, message });
    warnings.push(`The checklist agent could not be queued (${message}). Run it manually.`);
  }

  // ── Step 5: credentials email ──────────────────────────────────────────────
  const mail = await sendEmail(
    email,
    welcomeEmail({
      fullName,
      username: created.username,
      password: created.temporaryPassword,
      brokerName,
    }),
  );

  if (mail.ok) {
    await asSystem(async (db) => {
      await db
        .update(clients)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(clients.id, created.id));

      await recordAudit(db, {
        actorType: 'system',
        action: 'client.credentials_sent',
        targetType: 'client',
        targetId: created.id,
        clientId: created.id,
        metadata: { messageId: mail.messageId },
      });
    });
  } else {
    warnings.push(
      `The credentials email failed to send (${mail.error}). Resend it from the admin page — ` +
        'the client cannot log in until they receive it.',
    );
  }

  return {
    clientId: created.id,
    username: created.username,
    temporaryPassword: created.temporaryPassword,
    created: true,
    driveFolderId,
    emailSent: mail.ok,
    warnings,
  };
}

/**
 * Reissue credentials for an existing client.
 *
 * Generates a fresh password, forces a change on next login, and revokes any
 * live sessions — so this doubles as the "client is locked out" and the
 * "client's email was compromised" button.
 */
export async function reissueCredentials(
  db: Db,
  clientId: string,
  brokerName: string,
): Promise<{ ok: boolean; error?: string }> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return { ok: false, error: 'Client not found.' };

  const temporaryPassword = generatePassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await db
    .update(clients)
    .set({
      passwordHash,
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId));

  // Kill live sessions. Deleted inline rather than via lib/auth/session so this
  // module stays importable from the mail worker, which has no `next/headers`.
  await db
    .delete(sessions)
    .where(and(eq(sessions.userType, 'client'), eq(sessions.userId, clientId)));

  const mail = await sendEmail(
    client.email,
    welcomeEmail({
      fullName: client.fullName,
      username: client.username,
      password: temporaryPassword,
      brokerName,
    }),
  );

  await recordAudit(db, {
    actorType: 'broker',
    action: 'client.credentials_sent',
    targetType: 'client',
    targetId: clientId,
    clientId,
    metadata: { reissued: true, emailSent: mail.ok },
  });

  return mail.ok ? { ok: true } : { ok: false, error: mail.error };
}
