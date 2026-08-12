import { redirect } from 'next/navigation';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { asBroker } from '@/db';
import { brokers } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { getCurrentUser } from '@/lib/auth/session';
import { listDealCards } from '@/lib/deals/queries';
import { env } from '@/lib/env';
import { DealBoard, type BoardDeal } from './deal-board';

export const dynamic = 'force-dynamic';

export default async function DealsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const { cards, team } = await asBroker(user.id, async (db) => ({
    cards: await listDealCards(db),
    team: await db
      .select({ id: brokers.id, fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true)),
  }));

  const deals: BoardDeal[] = cards.map((card) => ({
    id: card.id,
    reference: card.reference,
    dealType: card.dealType,
    stageKey: card.stageKey,
    status: card.status,
    assignedTo: card.assignedTo,
    locked: card.lockedAt !== null,
    mortgageAmount: card.mortgageAmount,
    propertyCity: card.propertyCity,
    propertyProvince: card.propertyProvince,
    leadSource: card.leadSource,
    borrowerNames: card.borrowerNames,
    awaitingReview: card.awaitingReview,
    outstanding: card.outstanding,
    unread: card.unread,
    updatedAt: card.updatedAt.toISOString(),
  }));

  const volume = deals.reduce((sum, deal) => sum + (deal.mortgageAmount ?? 0), 0);
  const attention = deals.filter((deal) => deal.unread > 0 || deal.awaitingReview > 0).length;

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Broker workspace"
        nav={<BrokerNav />}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Deals</h1>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              {deals.length} active
              {volume > 0 && (
                <>
                  {' · '}
                  {volume.toLocaleString('en-CA', {
                    style: 'currency',
                    currency: 'CAD',
                    maximumFractionDigits: 0,
                  })}{' '}
                  in the pipeline
                </>
              )}
              {attention > 0 && ` · ${attention} need your attention`}
            </p>
          </div>

          <Link href="/apply" className="btn btn-secondary" target="_blank">
            Application link
          </Link>
        </div>

        {deals.length === 0 ? (
          <div className="card px-5 py-16 text-center">
            <p className="text-sm font-medium">No deals yet</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-500)]">
              Share your application link and the first one will land here. Deals also open
              automatically when a client emails you.
            </p>
            <Link href="/apply" className="btn btn-secondary mt-4">
              Preview the application
            </Link>
          </div>
        ) : (
          <DealBoard deals={deals} team={team} />
        )}
      </main>
    </div>
  );
}
