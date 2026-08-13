/**
 * Signing a consent.
 *
 * The document is rendered SERVER-SIDE and hashed here, not accepted from the
 * request. If the client sent the text it agreed to, a modified page could
 * record consent to something the borrower never saw — which would make the
 * whole audit trail worthless. The body only carries the kind and the typed
 * name; everything provable is derived on this side.
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { asClient, asSystem } from '@/db';
import { brokers, consents, dealBorrowers } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { requireClient } from '@/lib/auth/session';
import {
  CONSENT_DOCUMENTS,
  hashConsentDocument,
  renderConsent,
  signatureLooksLikeName,
  type ConsentKind,
} from '@/lib/compliance/consent';
import { env } from '@/lib/env';

const bodySchema = z.object({
  kind: z.enum(Object.keys(CONSENT_DOCUMENTS) as [ConsentKind, ...ConsentKind[]]),
  dealId: z.string().uuid(),
  signedName: z.string().trim().min(2).max(200),
  agreed: z.literal(true),
});

export async function POST(request: Request) {
  let user;
  try {
    user = await requireClient();
  } catch {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Type your full name and tick the box to sign.' },
      { status: 400 },
    );
  }

  const { kind, dealId, signedName } = parsed.data;

  const brokerageName = await asSystem(async (db) => {
    const [broker] = await db
      .select({ brokerageName: brokers.brokerageName, fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true))
      .limit(1);
    return broker?.brokerageName || broker?.fullName || env.appName;
  });

  const document = renderConsent(kind, brokerageName);
  const documentHash = hashConsentDocument(document);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null;

  const outcome = await asClient(user.id, async (db) => {
    // RLS would refuse a write scoped to someone else's deal anyway; this
    // returns a clean message instead of a policy violation.
    const [borrower] = await db
      .select({ dealId: dealBorrowers.dealId })
      .from(dealBorrowers)
      .where(and(eq(dealBorrowers.dealId, dealId), eq(dealBorrowers.clientId, user.id)))
      .limit(1);

    if (!borrower) {
      return { ok: false as const, status: 404, error: 'That application was not found.' };
    }

    const [existing] = await db
      .select({ id: consents.id })
      .from(consents)
      .where(
        and(
          eq(consents.clientId, user.id),
          eq(consents.dealId, dealId),
          eq(consents.kind, kind),
          eq(consents.documentHash, documentHash),
        ),
      )
      .limit(1);

    // Already signed THIS version. Signing again would add a duplicate record
    // of the same agreement; a new version would not match the hash and would
    // fall through to a fresh signature, which is the intended behaviour.
    if (existing) return { ok: true as const, alreadySigned: true };

    await db.insert(consents).values({
      clientId: user.id,
      dealId,
      kind,
      version: document.version,
      documentTitle: document.title,
      documentBody: document.body,
      documentHash,
      signedName,
      ipAddress: ip,
      userAgent,
    });

    await recordAudit(db, {
      actorType: 'client',
      actorId: user.id,
      action: 'consent.signed',
      targetType: 'consent',
      targetId: dealId,
      clientId: user.id,
      metadata: { kind, version: document.version, documentHash },
      ipAddress: ip,
    });

    return { ok: true as const, alreadySigned: false };
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  return NextResponse.json({
    ok: true,
    alreadySigned: outcome.alreadySigned,
    // Recorded and surfaced to the broker rather than blocking the borrower:
    // people sign as "Liz" when the file says "Elizabeth", and refusing that
    // would be both wrong and insulting.
    nameMismatch: !signatureLooksLikeName(signedName, user.fullName),
  });
}
