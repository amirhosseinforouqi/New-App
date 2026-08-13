import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';

import { asClient, asSystem } from '@/db';
import { brokers, consents, dealBorrowers, deals } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { getCurrentUser } from '@/lib/auth/session';
import { CONSENT_DOCUMENTS, renderConsent, type ConsentKind } from '@/lib/compliance/consent';
import { env } from '@/lib/env';
import { ConsentList, type ConsentCard } from './consent-form';

export const dynamic = 'force-dynamic';

export default async function ConsentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'client') redirect('/broker');

  const params = await searchParams;
  const requestedDeal = Array.isArray(params.deal) ? params.deal[0] : params.deal;

  const brokerageName = await asSystem(async (db) => {
    const [broker] = await db
      .select({ brokerageName: brokers.brokerageName, fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true))
      .limit(1);
    return broker?.brokerageName || broker?.fullName || env.appName;
  });

  const data = await asClient(user.id, async (db) => {
    const myDeals = await db
      .select({
        id: deals.id,
        reference: deals.reference,
        dealType: deals.dealType,
      })
      .from(dealBorrowers)
      .innerJoin(deals, eq(deals.id, dealBorrowers.dealId))
      .where(eq(dealBorrowers.clientId, user.id))
      .orderBy(desc(deals.createdAt));

    const active = myDeals.find((deal) => deal.id === requestedDeal) ?? myDeals[0];
    if (!active) return { myDeals, active: null, signed: [] };

    const signed = await db
      .select({
        kind: consents.kind,
        signedAt: consents.signedAt,
        signedName: consents.signedName,
      })
      .from(consents)
      .where(and(eq(consents.clientId, user.id), eq(consents.dealId, active.id)));

    return { myDeals, active, signed };
  });

  const signedByKind = new Map(data.signed.map((row) => [row.kind, row]));

  const cards: ConsentCard[] = (Object.keys(CONSENT_DOCUMENTS) as ConsentKind[]).map((kind) => {
    const document = renderConsent(kind, brokerageName);
    const signature = signedByKind.get(kind);

    return {
      kind,
      title: document.title,
      body: document.body,
      required: document.required,
      signedAt: signature?.signedAt.toISOString() ?? null,
      signedName: signature?.signedName ?? null,
    };
  });

  const outstanding = cards.filter((card) => card.required && !card.signedAt).length;

  return (
    <div className="min-h-dvh">
      <AppHeader appName={env.appName} userName={user.fullName} subtitle="Client portal" />

      <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/dashboard"
          className="text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← Back to your application
        </Link>

        <h1 className="mt-3 mb-1 text-[22px] font-semibold tracking-[-0.01em]">
          Forms to sign
        </h1>
        <p className="mb-6 text-sm text-[var(--color-ink-500)]">
          {outstanding === 0
            ? 'Everything required is signed. Thank you.'
            : `${outstanding} still needed before your file can go to a lender.`}
          {data.active && (
            <>
              {' '}
              For <span className="font-mono">{data.active.reference}</span>.
            </>
          )}
        </p>

        {!data.active ? (
          <div className="card p-5">
            <p className="text-sm">There is no application on your account yet.</p>
          </div>
        ) : (
          <ConsentList consents={cards} dealId={data.active.id} fullName={user.fullName} />
        )}
      </main>
    </div>
  );
}
