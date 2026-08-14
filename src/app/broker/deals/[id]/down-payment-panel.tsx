/**
 * Down-payment source of funds.
 *
 * The 90-day audit a lender requires, whether entered by the broker or written
 * by the agent skill. `source` is shown on every row on purpose: a finding an
 * AI produced is a lead to check, not a verified fact, and a broker signing off
 * on a file needs to know which is which.
 *
 * Nothing here marks anything verified. That is a human act, done from the
 * compliance checklist.
 */

import type { Workspace } from '@/lib/deals/workspace';

const money = (value: number) =>
  value.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

const SOURCE_LABELS: Record<string, string> = {
  savings: 'Savings',
  gift: 'Gift',
  sale_of_property: 'Sale of property',
  rrsp: 'RRSP / Home Buyers’ Plan',
  investments: 'Investments',
  unexplained_deposit: 'Deposit needing an explanation',
  other: 'Other',
};

export function DownPaymentPanel({
  sources,
  required,
}: {
  sources: Workspace['downPayment'];
  required: number | null;
}) {
  if (sources.length === 0) {
    return (
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Down payment</h2>
        <p className="field-hint mt-2">
          Nothing recorded. Run the statement audit from the agent panel on a bank statement, or
          add sources by hand — lenders want a 90-day history for these funds.
        </p>
      </section>
    );
  }

  const accounts = sources.filter((row) => row.sourceType !== 'unexplained_deposit');
  const flagged = sources.filter((row) => row.flagged);
  const total = accounts.reduce((sum, row) => sum + Number(row.amount), 0);
  const shortfall = required !== null ? required - total : null;

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Down payment</h2>
        <span className="text-[13px] text-[var(--color-ink-500)]">
          {money(total)} traced
          {required !== null && ` of ${money(required)}`}
        </span>
      </div>

      {shortfall !== null && shortfall > 1 && (
        <div className="alert alert-warn mt-3">
          {money(shortfall)} of the down payment has no source recorded yet.
        </div>
      )}

      <ul className="mt-4 divide-y divide-[var(--color-line)]">
        {sources.map((row) => (
          <li key={row.id} className="py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium">
                {SOURCE_LABELS[row.sourceType] ?? row.sourceType}
                {row.institution && (
                  <span className="font-normal text-[var(--color-ink-500)]"> · {row.institution}</span>
                )}
              </span>
              <span className="text-[13px] font-medium tabular-nums">
                {money(Number(row.amount))}
              </span>
            </div>

            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span
                className={
                  row.isVerified
                    ? 'badge badge-approved'
                    : row.flagged
                      ? 'badge badge-needs_attention'
                      : 'badge badge-requested'
                }
              >
                {row.isVerified ? 'Verified' : row.flagged ? 'Needs explanation' : 'Unverified'}
              </span>
              {/* Which is a human finding and which came from the model. */}
              <span className="text-[12px] text-[var(--color-ink-400)]">
                {row.source === 'agent' ? 'found by the statement audit' : 'entered by hand'}
                {row.asOfDate && ` · ${row.asOfDate}`}
              </span>
            </div>

            {row.flagReason && (
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-warn-600)]">
                {row.flagReason}
              </p>
            )}
            {row.notes && (
              <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                {row.notes}
              </p>
            )}
          </li>
        ))}
      </ul>

      {flagged.length > 0 && (
        <p className="field-hint mt-3">
          {flagged.length} item{flagged.length === 1 ? '' : 's'} a lender will ask about. Get a
          written explanation on file before submitting — this is the most common reason a deal
          stalls a week before closing.
        </p>
      )}
    </section>
  );
}
