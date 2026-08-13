import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { asBroker, asSystem } from '@/db';
import { brokers } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { getCurrentUser } from '@/lib/auth/session';
import {
  attributionReport,
  commissionSummary,
  fundedWithoutCommission,
  intakeBreakdown,
  listTeam,
  maturityPipeline,
} from '@/lib/team/queries';
import { env } from '@/lib/env';
import { TeamPanel } from './team-panel';

export const dynamic = 'force-dynamic';

const money = (value: number) =>
  value.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const [me] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  const isOwner = me?.role === 'owner';

  const data = await asBroker(user.id, async (db) => ({
    team: await listTeam(db),
    // Commissions are payroll. An agent seeing the whole brokerage's split
    // sheet is a personnel problem, so this is gated rather than merely hidden.
    commissions: isOwner ? await commissionSummary(db) : [],
    unclaimed: isOwner ? await fundedWithoutCommission(db) : [],
    attribution: await attributionReport(db),
    intake: await intakeBreakdown(db),
    maturities: await maturityPipeline(db),
  }));

  const totalPending = data.commissions.reduce((sum, row) => sum + row.pending, 0);
  const totalPaid = data.commissions.reduce((sum, row) => sum + row.paid, 0);

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Broker workspace"
        nav={<BrokerNav />}
      />

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="mb-1 text-[22px] font-semibold tracking-[-0.01em]">Brokerage</h1>
        <p className="mb-6 text-sm text-[var(--color-ink-500)]">
          Team, where the business comes from, and what it earned.
        </p>

        <div className="space-y-5">
          {/* ── Attribution ────────────────────────────────────────────── */}
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Where leads came from</h2>
            <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
              Last twelve months. Conversion is funded over leads — the number that decides
              whether a referral relationship is worth keeping.
            </p>

            {data.attribution.length === 0 ? (
              <p className="field-hint mt-3">No deals yet.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[480px] text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-500)]">
                      <th className="py-2 font-medium">Source</th>
                      <th className="py-2 text-right font-medium">Leads</th>
                      <th className="py-2 text-right font-medium">Funded</th>
                      <th className="py-2 text-right font-medium">Conversion</th>
                      <th className="py-2 text-right font-medium">Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.attribution.map((row) => (
                      <tr
                        key={row.code ?? row.source}
                        className="border-b border-[var(--color-line)] last:border-0"
                      >
                        <td className="py-2">
                          <span className="font-medium">
                            {row.label ?? row.code ?? row.source.replace(/_/g, ' ')}
                          </span>
                          {row.code && (
                            <span className="block font-mono text-[11px] text-[var(--color-ink-400)]">
                              ?ref={row.code}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">{row.leads}</td>
                        <td className="py-2 text-right tabular-nums">{row.funded}</td>
                        <td className="py-2 text-right tabular-nums">{row.conversionPercent}%</td>
                        <td className="py-2 text-right tabular-nums">{money(row.volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data.intake.length > 0 && (
              <p className="field-hint mt-3">
                Applications by form length:{' '}
                {data.intake
                  .map((row) => `${row.count} ${row.tier} (${row.locale.toUpperCase()})`)
                  .join(' · ')}
              </p>
            )}
          </section>

          {/* ── Commissions ────────────────────────────────────────────── */}
          {isOwner && (
            <section className="card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">Commissions</h2>
                <span className="text-[13px] text-[var(--color-ink-500)]">
                  {money(totalPaid)} paid · {money(totalPending)} pending
                </span>
              </div>

              {data.commissions.length === 0 ? (
                <p className="field-hint mt-3">
                  Nothing recorded yet. Commissions are entered against a funded deal.
                </p>
              ) : (
                <table className="mt-4 w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-500)]">
                      <th className="py-2 font-medium">Payee</th>
                      <th className="py-2 text-right font-medium">Deals</th>
                      <th className="py-2 text-right font-medium">Volume</th>
                      <th className="py-2 text-right font-medium">Paid</th>
                      <th className="py-2 text-right font-medium">Pending</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.commissions.map((row) => (
                      <tr
                        key={row.brokerId ?? row.payeeName}
                        className="border-b border-[var(--color-line)] last:border-0"
                      >
                        <td className="py-2 font-medium">{row.payeeName}</td>
                        <td className="py-2 text-right tabular-nums">{row.deals}</td>
                        <td className="py-2 text-right tabular-nums">{money(row.volume)}</td>
                        <td className="py-2 text-right tabular-nums">{money(row.paid)}</td>
                        <td className="py-2 text-right tabular-nums text-[var(--color-warn-600)]">
                          {money(row.pending)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {data.unclaimed.length > 0 && (
                <div className="alert alert-warn mt-4">
                  {data.unclaimed.length} funded deal{data.unclaimed.length === 1 ? '' : 's'} with
                  no commission recorded:{' '}
                  {data.unclaimed.slice(0, 4).map((deal, index) => (
                    <span key={deal.id}>
                      {index > 0 && ', '}
                      <Link href={`/broker/deals/${deal.id}`} className="underline">
                        {deal.reference}
                      </Link>
                    </span>
                  ))}
                  {data.unclaimed.length > 4 && '…'}
                </div>
              )}
            </section>
          )}

          {/* ── Renewals ───────────────────────────────────────────────── */}
          <section className="card p-5">
            <h2 className="text-sm font-semibold">Renewal pipeline</h2>
            <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
              Funded deals with a maturity date. Outreach goes out automatically at six months,
              ninety days, and once more if it lapses.
            </p>

            {data.maturities.length === 0 ? (
              <p className="field-hint mt-3">Nothing with a maturity date yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--color-line)]">
                {data.maturities.map((deal) => {
                  const days = deal.maturityDate
                    ? Math.round(
                        (new Date(deal.maturityDate).getTime() - Date.now()) / 86_400_000,
                      )
                    : null;

                  return (
                    <li key={deal.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
                      <Link
                        href={`/broker/deals/${deal.id}`}
                        className="font-mono font-medium hover:underline"
                      >
                        {deal.reference}
                      </Link>
                      <span className="text-[var(--color-ink-500)]">
                        {deal.existingLender ?? 'lender not recorded'}
                      </span>
                      <span className="ml-auto tabular-nums">
                        {deal.maturityDate}
                        {days !== null && (
                          <span
                            className={
                              days < 0
                                ? ' text-[var(--color-danger-600)]'
                                : days < 180
                                  ? ' text-[var(--color-warn-600)]'
                                  : ' text-[var(--color-ink-400)]'
                            }
                          >
                            {' '}
                            ({days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`})
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Team ───────────────────────────────────────────────────── */}
          <TeamPanel
            team={data.team.map((member) => ({
              ...member,
              lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
              inviteAcceptedAt: member.inviteAcceptedAt?.toISOString() ?? null,
            }))}
            isOwner={isOwner}
            currentBrokerId={user.id}
            appUrl={env.appUrl}
          />
        </div>
      </main>
    </div>
  );
}
