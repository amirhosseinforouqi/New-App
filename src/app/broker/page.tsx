/**
 * Broker dashboard — the pipeline board.
 *
 * Borrowed from BluMortgage and Velocity: everything flows into a single list
 * regardless of where it originated (inbound email, manual entry), with the
 * counts that decide what to do next visible without opening a file.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { desc, sql } from 'drizzle-orm';

import { asBroker } from '@/db';
import { clients, documentRequests, documents, messages } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { NewClientForm } from './new-client-form';
import { getCurrentUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { STAGES, getStage } from '@/lib/pipeline/stages';

export const dynamic = 'force-dynamic';

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

export default async function BrokerPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const rows = await asBroker(user.id, async (db) =>
    db
      .select({
        id: clients.id,
        fullName: clients.fullName,
        email: clients.email,
        username: clients.username,
        status: clients.status,
        stageKey: clients.stageKey,
        applicationType: clients.applicationType,
        createdAt: clients.createdAt,
        driveFolderId: clients.driveFolderId,
        // `clients.id` literal, not `${clients.id}` — interpolation renders it
        // unqualified and it binds to the inner table. See the note in
        // `src/lib/deals/queries.ts`.
        awaitingReview: sql<number>`(
          SELECT count(*)::int FROM ${documents} d
           WHERE d.client_id = clients.id AND d.status = 'in_review'
        )`,
        outstanding: sql<number>`(
          SELECT count(*)::int FROM ${documentRequests} r
           WHERE r.client_id = clients.id AND r.status IN ('requested', 'needs_attention')
        )`,
        unread: sql<number>`(
          SELECT count(*)::int FROM ${messages} m
           WHERE m.client_id = clients.id AND m.sender_type = 'client' AND m.read_at IS NULL
        )`,
      })
      .from(clients)
      .where(sql`${clients.status} <> 'archived'`)
      .orderBy(desc(clients.updatedAt)),
  );

  const byStage = new Map<string, number>();
  for (const row of rows) {
    byStage.set(row.stageKey, (byStage.get(row.stageKey) ?? 0) + 1);
  }

  const needsAttention = rows.filter((row) => row.awaitingReview > 0 || row.unread > 0);

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
            <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Clients</h1>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              {rows.length} active file{rows.length === 1 ? '' : 's'}
              {needsAttention.length > 0 && ` · ${needsAttention.length} need your attention`}
            </p>
          </div>
          <NewClientForm />
        </div>

        {/* Pipeline counts — a horizontal scroller on mobile rather than a
            wrapped grid, so the stage order stays readable. */}
        <div className="mb-6 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <div className="flex min-w-max gap-2 sm:min-w-0">
            {STAGES.map((stage) => (
              <div
                key={stage.key}
                className="card flex-1 px-3 py-2.5 sm:min-w-0"
                title={stage.brokerHint}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-400)]">
                  {stage.label}
                </p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {byStage.get(stage.key) ?? 0}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="card overflow-hidden">
          {rows.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <p className="text-sm font-medium">No clients yet</p>
              <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                Add one above, or simply have a client email you — the portal creates their
                profile and sends their login details automatically.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {rows.map((row) => {
                const stage = getStage(row.stageKey);
                return (
                  <li key={row.id}>
                    <Link
                      href={`/broker/clients/${row.id}`}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-[var(--color-raised)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{row.fullName}</p>
                          {row.status === 'invited' && (
                            <span className="badge badge-requested">Not signed in yet</span>
                          )}
                          {!row.driveFolderId && (
                            <span className="badge badge-needs_attention">No Drive folder</span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[13px] text-[var(--color-ink-500)]">
                          {row.email} · {row.applicationType} · added {relativeTime(row.createdAt)}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        {row.unread > 0 && (
                          <span className="badge badge-in_review">
                            {row.unread} message{row.unread === 1 ? '' : 's'}
                          </span>
                        )}
                        {row.awaitingReview > 0 && (
                          <span className="badge badge-in_review">
                            {row.awaitingReview} to review
                          </span>
                        )}
                        {row.outstanding > 0 && (
                          <span className="badge badge-requested">
                            {row.outstanding} outstanding
                          </span>
                        )}
                      </div>

                      <div className="w-full sm:w-[170px]">
                        <p className="text-[13px] font-medium text-[var(--color-accent-700)]">
                          {stage.label}
                        </p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
