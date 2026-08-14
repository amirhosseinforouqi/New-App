import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { asBroker } from '@/db';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { getCurrentUser } from '@/lib/auth/session';
import { dealRatios, getDealDetail, num } from '@/lib/deals/queries';
import { ensureComplianceChecklist, loadWorkspace } from '@/lib/deals/workspace';
import { env } from '@/lib/env';
import { calculateInsurance, minimumDownPayment } from '@/lib/finance/mortgage';
import { calculateLandTransferTax, type Province } from '@/lib/finance/land-transfer-tax';
import { getStage, STAGES } from '@/lib/pipeline/stages';
import { RatioPanel } from './ratio-panel';
import { ConnectionsPanel } from './connections-panel';
import { DownPaymentPanel } from './down-payment-panel';
import { ScenarioPanel } from './scenario-panel';
import { SubmitControl } from './submit-control';
import {
  CompliancePanel,
  CrossSellPanel,
  LenderPanel,
  ReadinessPanel,
} from './workspace-panels';

export const dynamic = 'force-dynamic';

const money = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : value.toLocaleString('en-CA', {
        style: 'currency',
        currency: 'CAD',
        maximumFractionDigits: 0,
      });

const DEAL_TYPE_LABELS: Record<string, string> = {
  purchase: 'Purchase',
  refinance: 'Refinance',
  renewal: 'Renewal',
  heloc: 'HELOC',
  preapproval: 'Pre-approval',
  construction: 'Construction',
  commercial: 'Commercial',
};

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const { id } = await params;
  const detail = await asBroker(user.id, async (db) => getDealDetail(db, id));
  if (!detail) notFound();

  // Created on first view rather than at deal creation: a deal opened from an
  // EZ-tier lead has no borrowers yet, and a per-borrower checklist built
  // before the borrowers exist is the wrong checklist.
  const workspace = await asBroker(user.id, async (db) => {
    await ensureComplianceChecklist(
      db,
      detail.deal.id,
      detail.deal.dealType,
      detail.borrowers.map((borrower) => ({
        clientId: borrower.clientId,
        fullName: borrower.fullName,
      })),
    );
    return loadWorkspace(db, detail);
  });

  const { deal, borrowers, incomes, liabilities } = detail;
  const stage = getStage(deal.stageKey);
  const stageIndex = STAGES.findIndex((item) => item.key === deal.stageKey);

  const { ratios: stressed, blockedBy, rateIsAssumed } = dealRatios(detail);
  const { ratios: contract } = dealRatios(detail, { useStressTest: false });

  const purchasePrice = num(deal.purchasePrice);
  const downPayment = num(deal.downPayment);
  const propertyValue = num(deal.propertyValue) ?? purchasePrice;

  const insurance =
    deal.dealType === 'purchase' && purchasePrice !== null && downPayment !== null
      ? calculateInsurance(purchasePrice, downPayment)
      : null;

  const minimumDown = purchasePrice !== null ? minimumDownPayment(purchasePrice) : null;

  const ltt =
    deal.dealType === 'purchase' && purchasePrice !== null && deal.propertyProvince
      ? calculateLandTransferTax({
          purchasePrice,
          province: deal.propertyProvince as Province,
          city: deal.propertyCity ?? undefined,
        })
      : null;

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Broker workspace"
        nav={<BrokerNav />}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/broker/deals"
          className="text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← All deals
        </Link>

        <div className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] font-semibold tracking-[-0.01em]">
                {borrowers.find((b) => b.role === 'primary')?.fullName ??
                  borrowers[0]?.fullName ??
                  'Unnamed deal'}
              </h1>
              {deal.lockedAt && <span className="badge badge-needs_attention">Locked</span>}
              {deal.status === 'archived' && (
                <span className="badge badge-requested">Archived</span>
              )}
            </div>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              <span className="font-mono">{deal.reference}</span> ·{' '}
              {DEAL_TYPE_LABELS[deal.dealType] ?? deal.dealType}
              {deal.leadSource && ` · via ${deal.leadSource.replace(/_/g, ' ')}`}
              {deal.referralCode && ` · ref ${deal.referralCode}`}
            </p>
          </div>

          <div className="text-right">
            <p className="text-[11px] font-semibold tracking-wide text-[var(--color-ink-400)] uppercase">
              Stage {stageIndex + 1} of {STAGES.length}
            </p>
            <p className="text-sm font-semibold text-[var(--color-accent-700)]">{stage.label}</p>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          <div className="space-y-5">
            <ReadinessPanel readiness={workspace.readiness} />

            <RatioPanel
              stressed={stressed}
              contract={contract}
              blockedBy={blockedBy}
              rateIsAssumed={rateIsAssumed}
            />

            <LenderPanel matches={workspace.matches} />

            <ScenarioPanel
              dealId={deal.id}
              scenarios={workspace.scenarios.map((scenario) => ({
                id: scenario.id,
                name: scenario.name,
                createdAt: scenario.createdAt.toISOString(),
                options: scenario.snapshot.options ?? [],
                cheapestOverTerm: scenario.comparison.cheapestOverTerm,
                lowestPayment: scenario.comparison.lowestPayment,
                spreadOverTerm: scenario.comparison.spreadOverTerm,
                termsDiffer: scenario.comparison.termsDiffer,
                termYears: scenario.comparison.termYears,
                drift: scenario.drift,
              }))}
              products={workspace.matches.map((match) => ({
                id: match.product.id,
                label: `${match.product.lenderName} ${match.product.name}`,
                rate: match.product.postedRate,
                fits: match.fits,
              }))}
            />

            <DownPaymentPanel sources={workspace.downPayment} required={downPayment} />

            <ConnectionsPanel
              dealId={deal.id}
              kinds={workspace.connections.map((summary) => ({
                ...summary.kind,
                records: [...summary.byClient.values()].flat().map((record) => ({
                  ...record,
                  requestedAt: record.requestedAt.toISOString(),
                  completedAt: record.completedAt?.toISOString() ?? null,
                })),
                outstandingFor: summary.outstandingFor,
              }))}
              borrowers={detail.borrowers.map((borrower) => ({
                clientId: borrower.clientId,
                fullName: borrower.fullName,
                consentSigned: workspace.consentByClient.get(borrower.clientId) ?? false,
              }))}
            />

            <SubmitControl
              dealId={deal.id}
              reference={deal.reference}
              ready={workspace.readiness.ready}
              blockingCount={workspace.readiness.blocking.length}
              warningCount={workspace.readiness.warnings.length}
              lenders={workspace.lenderOptions}
              lastSubmittedAt={workspace.lastSubmittedAt?.toISOString() ?? null}
            />

            <section className="card p-5">
              <h2 className="text-sm font-semibold">The mortgage</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
                {deal.dealType === 'purchase' ? (
                  <>
                    <Row label="Purchase price" value={money(purchasePrice)} />
                    <Row label="Down payment" value={money(downPayment)} />
                    <Row
                      label="Minimum required"
                      value={money(minimumDown)}
                      warn={
                        minimumDown !== null && downPayment !== null && downPayment < minimumDown
                      }
                    />
                  </>
                ) : (
                  <>
                    <Row label="Property value" value={money(propertyValue)} />
                    <Row label="Existing balance" value={money(num(deal.existingBalance))} />
                    <Row label="Current lender" value={deal.existingLender ?? '—'} />
                    <Row label="Maturity" value={deal.maturityDate ?? '—'} />
                  </>
                )}
                <Row label="Mortgage requested" value={money(num(deal.mortgageAmount))} strong />
                <Row
                  label="Rate"
                  value={deal.interestRate ? `${num(deal.interestRate)}%` : 'Not quoted'}
                />
                <Row label="Amortization" value={`${deal.amortizationYears ?? 25} years`} />
                <Row label="Payment frequency" value={deal.paymentFrequency ?? 'monthly'} />
              </dl>

              {insurance && insurance.required && (
                <div className={insurance.qualifies ? 'alert alert-warn mt-4' : 'alert alert-error mt-4'}>
                  {insurance.qualifies ? (
                    <>
                      Default insurance required at {insurance.premiumRate}% —{' '}
                      {money(insurance.premium)} added to the mortgage, for a total of{' '}
                      {money(insurance.totalMortgage)}.
                    </>
                  ) : (
                    <>
                      Loan-to-value is above 95%. No insurer will write this — the down payment
                      has to increase before the file can go anywhere.
                    </>
                  )}
                </div>
              )}

              {ltt && (
                <p className="field-hint mt-4">
                  {ltt.supported
                    ? `Land transfer tax ≈ ${money(ltt.totalTax)}. ${ltt.note}`
                    : ltt.note}
                </p>
              )}
            </section>

            <section className="card p-5">
              <h2 className="text-sm font-semibold">The property</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
                <Row
                  label="Address"
                  value={
                    [deal.propertyAddress, deal.propertyCity, deal.propertyProvince]
                      .filter(Boolean)
                      .join(', ') || 'Not chosen yet'
                  }
                />
                <Row label="Type" value={deal.propertyType?.replace(/_/g, ' ') ?? '—'} />
                <Row label="Occupancy" value={deal.occupancy?.replace(/_/g, ' ') ?? '—'} />
                <Row label="Annual property tax" value={money(num(deal.annualPropertyTax))} />
                <Row label="Condo fees (monthly)" value={money(num(deal.monthlyCondoFees))} />
                <Row label="Heat (monthly)" value={money(num(deal.monthlyHeat))} />
              </dl>
            </section>

            <section className="card p-5">
              <h2 className="text-sm font-semibold">Income</h2>
              {incomes.length === 0 ? (
                <p className="field-hint mt-2">Nothing recorded yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-[var(--color-line)]">
                  {incomes.map((income) => {
                    const borrower = borrowers.find((b) => b.clientId === income.clientId);
                    return (
                      <li key={income.id} className="flex justify-between gap-3 py-2.5 text-[13px]">
                        <div className="min-w-0">
                          <p className="font-medium">{borrower?.fullName ?? 'Borrower'}</p>
                          <p className="text-[var(--color-ink-500)]">
                            {income.employmentType.replace(/_/g, ' ')}
                            {income.employerName && ` · ${income.employerName}`}
                          </p>
                        </div>
                        <div className="shrink-0 text-right tabular-nums">
                          <p className="font-medium">{money(Number(income.annualIncome))}</p>
                          {income.priorYearIncome && (
                            <p className="text-[var(--color-ink-400)]">
                              prior {money(Number(income.priorYearIncome))}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="card p-5">
              <h2 className="text-sm font-semibold">Liabilities</h2>
              {liabilities.length === 0 ? (
                <p className="field-hint mt-2">
                  Nothing recorded. Self-declared only until a credit bureau is pulled.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-[var(--color-line)]">
                  {liabilities.map((item) => (
                    <li key={item.id} className="flex justify-between gap-3 py-2.5 text-[13px]">
                      <div className="min-w-0">
                        <p className="font-medium">{item.description ?? item.liabilityType}</p>
                        <p className="text-[var(--color-ink-500)]">
                          {item.payoutOnClosing
                            ? 'Paid out on closing — excluded from TDS'
                            : item.includeInTds
                              ? 'Counted in TDS'
                              : 'Excluded from TDS'}
                          {' · '}
                          {item.source === 'client' ? 'self-declared' : item.source}
                        </p>
                      </div>
                      <p className="shrink-0 font-medium tabular-nums">
                        {money(Number(item.monthlyPayment))}/mo
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <aside className="space-y-5">
            <section className="card p-5">
              <h2 className="text-sm font-semibold">Borrowers</h2>
              <ul className="mt-3 space-y-3">
                {borrowers.map((borrower) => (
                  <li key={borrower.clientId}>
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-semibold">{borrower.fullName}</p>
                      <span className="badge badge-requested">
                        {borrower.role.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-[13px] text-[var(--color-ink-500)]">{borrower.email}</p>
                    <p className="text-[12px] text-[var(--color-ink-400)]">
                      {borrower.username}
                      {borrower.acceptedAt ? '' : ' · has not signed in yet'}
                    </p>
                    <Link
                      href={`/broker/clients/${borrower.clientId}`}
                      className="mt-1 inline-block text-[13px] text-[var(--color-accent-600)] hover:underline"
                    >
                      Documents and messages →
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="field-hint mt-4">
                Each borrower signs in separately and sees only their own income and liabilities.
              </p>
            </section>

            <CompliancePanel
              dealId={deal.id}
              documents={workspace.dealDocuments}
              items={workspace.compliance}
              borrowers={borrowers.map((borrower) => ({
                clientId: borrower.clientId,
                fullName: borrower.fullName,
              }))}
              identityByClient={workspace.identityByClient}
              consentByClient={workspace.consentByClient}
            />

            <CrossSellPanel suggestions={workspace.crossSell} />

            {deal.notes && (
              <section className="card p-5">
                <h2 className="text-sm font-semibold">From the application</h2>
                <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--color-ink-700)]">
                  {deal.notes}
                </p>
              </section>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
  warn = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  warn?: boolean;
}) {
  return (
    <>
      <dt className="text-[var(--color-ink-500)]">{label}</dt>
      <dd
        className={
          'text-right tabular-nums ' +
          (warn ? 'font-semibold text-[var(--color-danger-600)]' : strong ? 'font-semibold' : 'font-medium')
        }
      >
        {value}
      </dd>
    </>
  );
}
