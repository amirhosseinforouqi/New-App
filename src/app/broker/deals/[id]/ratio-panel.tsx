/**
 * The three numbers that decide whether a file is fundable.
 *
 * Shown at the stress-test rate by default and labelled as such, because a GDS
 * calculated at the contract rate is the number that gets a file declined after
 * everyone has already celebrated. The contract-rate figures sit alongside it
 * so the broker can tell the borrower what they will actually pay.
 *
 * A ratio bar is never just a colour — every one carries its percentage, the
 * limit it is measured against, and a pass/fail word.
 */

import { GDS_LIMIT, TDS_LIMIT, type RatioResult } from '@/lib/finance/ratios';

const money = (value: number) =>
  value.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

export function RatioPanel({
  stressed,
  contract,
  blockedBy,
  rateIsAssumed,
}: {
  stressed: RatioResult | null;
  contract: RatioResult | null;
  blockedBy: string[];
  rateIsAssumed: boolean;
}) {
  if (!stressed || !contract) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">Qualifying ratios</h2>
        <div className="alert alert-warn mt-3">
          Cannot be calculated yet — this file is missing {blockedBy.join(', ')}.
        </div>
        <p className="field-hint">
          Fill these in on the file and GDS, TDS and LTV appear here immediately.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Qualifying ratios</h2>
        <p className="text-[13px] text-[var(--color-ink-500)]">
          At the stress-test rate of{' '}
          <strong className="text-[var(--color-ink-700)]">
            {stressed.qualifyingRatePercent}%
          </strong>
        </p>
      </div>

      <div className="mt-4 space-y-4">
        <RatioBar label="GDS" value={stressed.gds} limit={GDS_LIMIT} passes={stressed.gdsPasses} />
        <RatioBar label="TDS" value={stressed.tds} limit={TDS_LIMIT} passes={stressed.tdsPasses} />
        <RatioBar label="LTV" value={stressed.ltv} limit={80} passes={stressed.ltv <= 80} softLimit />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-[var(--color-line)] pt-4 text-[13px]">
        <Row label="Gross monthly income" value={money(stressed.grossMonthlyIncome)} />
        <Row
          label="Monthly payment at qualifying rate"
          value={money(stressed.monthlyMortgagePayment)}
        />
        <Row label="Property tax (monthly)" value={money(stressed.monthlyPropertyTax)} />
        <Row label="Heat" value={money(stressed.monthlyHeat)} />
        <Row label="Condo fees counted (50%)" value={money(stressed.condoFeesCounted)} />
        <Row label="Other debt payments" value={money(stressed.otherDebtPayments)} />
        <Row label="Total housing costs" value={money(stressed.housingCosts)} />
        <Row label="Max mortgage by ratios" value={money(stressed.maxMortgageByRatios)} />
      </dl>

      <div className="mt-4 rounded-[var(--radius-control)] bg-[var(--color-canvas)] px-4 py-3">
        <p className="text-[13px] font-semibold text-[var(--color-ink-700)]">
          {rateIsAssumed
            ? `At an assumed rate of ${contract.qualifyingRatePercent}%`
            : `At the contract rate of ${contract.qualifyingRatePercent}%`}
        </p>
        <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
          Payment {money(contract.monthlyMortgagePayment)} · GDS {contract.gds}% · TDS{' '}
          {contract.tds}%.{' '}
          {rateIsAssumed
            ? 'No rate has been quoted on this file yet, so these figures move as soon as one is.'
            : 'This is what they actually pay — not what they qualify on.'}
        </p>
      </div>

      {stressed.warnings.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {stressed.warnings.map((warning) => (
            <li key={warning} className="alert alert-warn">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RatioBar({
  label,
  value,
  limit,
  passes,
  softLimit = false,
}: {
  label: string;
  value: number;
  limit: number;
  passes: boolean;
  softLimit?: boolean;
}) {
  // Scaled so the limit sits at 75% of the track — a ratio over its limit still
  // has somewhere to go, instead of pinning at full width and hiding how bad
  // it is.
  const width = Math.min((value / (limit / 0.75)) * 100, 100);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">{label}</span>
        <span className="text-[13px] tabular-nums">
          <strong className={passes ? 'text-[var(--color-ok-600)]' : 'text-[var(--color-danger-600)]'}>
            {value}%
          </strong>
          <span className="text-[var(--color-ink-400)]">
            {' '}
            / {limit}% {passes ? (softLimit ? 'conventional' : 'pass') : softLimit ? 'insured' : 'over'}
          </span>
        </span>
      </div>

      <div className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--color-line)]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${width}%`,
            background: passes ? 'var(--color-ok-600)' : 'var(--color-danger-600)',
          }}
        />
        {/* The limit marker, so the bar is readable without doing arithmetic. */}
        <div
          className="absolute inset-y-0 w-px bg-[var(--color-ink-700)]"
          style={{ left: '75%' }}
          aria-hidden
        />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--color-ink-500)]">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </>
  );
}
