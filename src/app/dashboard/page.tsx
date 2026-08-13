/**
 * Client dashboard.
 *
 * Server component: every query runs under the client's own RLS context, so
 * this page physically cannot render another client's data even if a query
 * below were written wrong.
 */

import { redirect } from 'next/navigation';
import { and, asc, desc, eq } from 'drizzle-orm';

import { asClient, asSystem } from '@/db';
import {
  brokers,
  clientStageHistory,
  consents,
  documentRequests,
  documents,
  messages,
} from '@/db/schema';
import Link from 'next/link';
import { AppHeader } from '@/components/app-header';
import { DocumentPanel } from '@/components/document-panel';
import { MessageThread } from '@/components/message-thread';
import { StageTimeline } from '@/components/stage-timeline';
import { getCurrentUser } from '@/lib/auth/session';
import { listDealsForClient } from '@/lib/deals/queries';
import { requiredConsentKinds } from '@/lib/compliance/consent';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'client') redirect('/broker');
  if (user.mustChangePassword) redirect('/change-password');

  const params = await searchParams;
  const requestedDeal = Array.isArray(params.deal) ? params.deal[0] : params.deal;

  // Sequential, not Promise.all. Every query here shares the ONE pooled
  // connection that `withActor` has a transaction open on, and node-postgres
  // cannot run concurrent queries on a single client — it queues them and
  // warns, and future versions throw. Four indexed reads on a warm connection
  // are not worth the risk of interleaving them.
  const data = await asClient(user.id, async (db) => {
    // One person, many applications — a purchase this year and a refinance in
    // three. RLS already limits this to deals they are a borrower on, so the
    // requested id cannot be someone else's.
    const myDeals = await listDealsForClient(db, user.id);
    const active = myDeals.find((deal) => deal.id === requestedDeal) ?? myDeals[0] ?? null;

    // Scoped to the selected deal when there is one. `and()` drops undefined,
    // so a client with no deal at all still sees their file rather than an
    // empty dashboard.
    const signedConsents = await db
      .select({ kind: consents.kind })
      .from(consents)
      .where(eq(consents.clientId, user.id));

    const checklist = await db
      .select()
      .from(documentRequests)
      .where(
        and(
          eq(documentRequests.clientId, user.id),
          active ? eq(documentRequests.dealId, active.id) : undefined,
        ),
      )
      .orderBy(asc(documentRequests.sortOrder));

    const uploaded = await db
      .select()
      .from(documents)
      .where(
        and(eq(documents.clientId, user.id), active ? eq(documents.dealId, active.id) : undefined),
      )
      .orderBy(desc(documents.createdAt));

    const thread = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.clientId, user.id), active ? eq(messages.dealId, active.id) : undefined),
      )
      .orderBy(asc(messages.createdAt));

    const history = await db
      .select()
      .from(clientStageHistory)
      .where(
        and(
          eq(clientStageHistory.clientId, user.id),
          active ? eq(clientStageHistory.dealId, active.id) : undefined,
        ),
      )
      .orderBy(asc(clientStageHistory.createdAt));

    return { checklist, uploaded, thread, history, myDeals, active, signedConsents };
  });

  // Broker name is used for message attribution. `brokers` is not a
  // client-scoped table (it carries no client data), so it is read under the
  // system actor rather than widening the client's own permissions.
  const brokerName = await asSystem(async (db) => {
    const [broker] = await db
      .select({ fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true))
      .limit(1);
    return broker?.fullName ?? 'Your broker';
  });

  // First time each stage was reached — later re-entries do not overwrite,
  // so a stage that was corrected backwards keeps its original date.
  const reachedAt: Record<string, string> = {};
  for (const entry of data.history) {
    reachedAt[entry.stageKey] ??= entry.createdAt.toISOString();
  }

  const firstName = user.fullName.trim().split(/\s+/)[0] ?? user.fullName;

  const signedKinds = new Set(data.signedConsents.map((row) => row.kind));
  const outstandingConsents = requiredConsentKinds().filter((kind) => !signedKinds.has(kind));

  // The stage shown comes from the SELECTED deal, not from clients.stage_key,
  // which only mirrors the most recently updated one. On a two-deal file the
  // mirror is right for one of them and wrong for the other.
  const currentStage = data.active?.stageKey ?? user.stageKey;

  const DEAL_TYPE_LABELS: Record<string, string> = {
    purchase: 'Purchase',
    refinance: 'Refinance',
    renewal: 'Renewal',
    heloc: 'Home equity',
    preapproval: 'Pre-approval',
  };

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Client portal"
        nav={
          <Link
            href="/settings/security"
            className="rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] font-semibold text-[var(--color-ink-500)] transition-colors hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink-900)]"
          >
            Security
          </Link>
        }
      />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Hello, {firstName}</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-500)]">
            {data.myDeals.length > 1
              ? 'You have more than one application with us. Pick the one you want to look at.'
              : 'Here is where your application stands.'}
          </p>
        </div>

        {/* Deal switcher — only when there is a choice to make. */}
        {data.myDeals.length > 1 && (
          <nav aria-label="Your applications" className="mb-6 flex flex-wrap gap-2">
            {data.myDeals.map((deal) => {
              const isActive = deal.id === data.active?.id;
              return (
                <Link
                  key={deal.id}
                  href={`/dashboard?deal=${deal.id}`}
                  aria-current={isActive ? 'page' : undefined}
                  className={
                    'card px-3.5 py-2.5 text-[13px] transition-colors ' +
                    (isActive
                      ? 'border-[var(--color-accent-700)] bg-[var(--color-accent-100)]'
                      : 'hover:border-[var(--color-accent-500)]')
                  }
                >
                  <span className="block font-semibold">
                    {DEAL_TYPE_LABELS[deal.dealType] ?? deal.dealType}
                  </span>
                  <span className="block font-mono text-[11px] text-[var(--color-ink-400)]">
                    {deal.reference}
                    {deal.role !== 'primary' && ' · with you'}
                  </span>
                </Link>
              );
            })}
          </nav>
        )}

        {outstandingConsents.length > 0 && (
          <div className="card mb-6 flex flex-wrap items-center justify-between gap-3 border-[var(--color-warn-600)] p-4">
            <p className="text-[13px]">
              <strong>
                {outstandingConsents.length} form
                {outstandingConsents.length === 1 ? '' : 's'} to sign.
              </strong>{' '}
              Your file cannot go to a lender until {outstandingConsents.length === 1 ? 'it is' : 'they are'} done.
            </p>
            <Link
              href={data.active ? `/consents?deal=${data.active.id}` : '/consents'}
              className="btn btn-primary"
            >
              Review and sign
            </Link>
          </div>
        )}

        <div className="space-y-6">
          <StageTimeline currentStageKey={currentStage} reachedAt={reachedAt} />

          <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
            <DocumentPanel
              checklist={data.checklist.map((item) => ({
                id: item.id,
                label: item.label,
                description: item.description,
                category: item.category,
                isRequired: item.isRequired,
                status: item.status,
                reviewNote: item.reviewNote,
              }))}
              documents={data.uploaded.map((doc) => ({
                id: doc.id,
                fileName: doc.fileName,
                mimeType: doc.mimeType,
                sizeBytes: doc.sizeBytes,
                status: doc.status,
                reviewNote: doc.reviewNote,
                requestId: doc.requestId,
                createdAt: doc.createdAt.toISOString(),
              }))}
            />

            <MessageThread
              clientId={user.id}
              viewerType="client"
              brokerName={brokerName}
              clientName={user.fullName}
              initialMessages={data.thread.map((message) => ({
                id: message.id,
                senderType: message.senderType,
                body: message.body,
                createdAt: message.createdAt.toISOString(),
              }))}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
