'use client';

/**
 * Side-by-side product comparisons.
 *
 * The comparison a borrower is shown is a record, not a view. Rates move
 * weekly, so each saved scenario keeps the numbers as they were on the day —
 * and where the live table has since moved, it says so above the table instead
 * of quietly showing today's figures under last week's heading.
 *
 * Cheapest and lowest-payment are marked separately because they are often
 * different products. A borrower choosing on cash flow deserves to be told that
 * is what they are doing rather than be steered by a single "best" badge.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ScenarioOptionView {
  productId: string;
  lenderName: string;
  productName: string;
  rateType: string;
  termYears: number;
  postedRate: number;
  monthlyPayment: number;
  totalInterestOverTerm: number;
  balanceAtEndOfTerm: number;
  fits: boolean;
}

export interface ScenarioDriftView {
  productId: string;
  lenderName: string;
  productName: string;
  quotedRate: number;
  currentRate: number | null;
  changePercent: number | null;
  unavailable: boolean;
}

export interface ScenarioView {
  id: string;
  name: string;
  createdAt: string;
  options: ScenarioOptionView[];
  cheapestOverTerm: string | null;
  lowestPayment: string | null;
  spreadOverTerm: number;
  termsDiffer: boolean;
  termYears: number[];
  drift: ScenarioDriftView[];
}

export interface SelectableProduct {
  id: string;
  label: string;
  rate: number;
  fits: boolean;
}

const money = (value: number) =>
  value.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

export function ScenarioPanel({
  dealId,
  scenarios,
  products,
}: {
  dealId: string;
  scenarios: ScenarioView[];
  products: SelectableProduct[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  async function post(body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/broker/deals/${dealId}/scenarios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not work.');
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError('Could not reach the server.');
      return false;
    } finally {
      setPending(false);
    }
  }

  function toggle(productId: string) {
    setSelected((current) =>
      current.includes(productId)
        ? current.filter((id) => id !== productId)
        : current.length >= 4
          ? current
          : [...current, productId],
    );
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Comparisons</h2>
        {products.length >= 2 && (
          <button
            type="button"
            className="btn btn-secondary px-3 py-1.5 text-[13px]"
            onClick={() => {
              setOpen((current) => !current);
              setError(null);
            }}
          >
            {open ? 'Cancel' : 'Build a comparison'}
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error mt-3" role="alert">
          {error}
        </div>
      )}

      {products.length < 2 && (
        <p className="field-hint mt-2">
          Needs at least two products in your table. Add them under <strong>Lenders</strong>.
        </p>
      )}

      {open && (
        <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-4">
          <label className="label" htmlFor="scenario-name">
            What to call it
          </label>
          <input
            id="scenario-name"
            className="input"
            value={name}
            placeholder="Fixed vs variable, Feb 14"
            onChange={(event) => setName(event.target.value)}
          />

          <p className="label mt-4">Pick two to four ({selected.length} chosen)</p>
          <div className="space-y-1.5">
            {products.map((product) => (
              <label
                key={product.id}
                className="flex cursor-pointer items-center gap-2.5 text-[13px]"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(product.id)}
                  onChange={() => toggle(product.id)}
                  className="h-4 w-4 accent-[var(--color-accent-700)]"
                />
                <span className={product.fits ? '' : 'text-[var(--color-ink-400)]'}>
                  {product.label} — {product.rate}%
                  {/* A product that does not fit can still be worth showing a
                      borrower, as the reason they are not getting that rate. */}
                  {!product.fits && ' · does not fit this file'}
                </span>
              </label>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-primary mt-4"
            disabled={pending || selected.length < 2 || name.trim() === ''}
            onClick={() =>
              void post({ action: 'save', name: name.trim(), productIds: selected }).then((ok) => {
                if (ok) {
                  setOpen(false);
                  setName('');
                  setSelected([]);
                }
              })
            }
          >
            {pending ? 'Saving…' : 'Save comparison'}
          </button>
        </div>
      )}

      {scenarios.length === 0 ? (
        !open && (
          <p className="field-hint mt-2">
            Nothing saved yet. A comparison freezes the rates as they are today, so what a borrower
            was shown stays on the file after the market moves.
          </p>
        )
      ) : (
        <div className="mt-4 space-y-5">
          {scenarios.map((scenario) => (
            <div key={scenario.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[13px] font-semibold">{scenario.name}</h3>
                <div className="flex items-baseline gap-3 text-[12px] text-[var(--color-ink-400)]">
                  <span>{new Date(scenario.createdAt).toLocaleDateString('en-CA')}</span>
                  <button
                    type="button"
                    className="underline hover:text-[var(--color-danger-600)]"
                    disabled={pending}
                    onClick={() => void post({ action: 'delete', scenarioId: scenario.id })}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {scenario.drift.length > 0 && (
                <div className="alert alert-warn mt-2">
                  {scenario.drift.map((item) => (
                    <p key={item.productId}>
                      {item.lenderName} {item.productName}{' '}
                      {item.unavailable
                        ? 'is no longer offered, so this comparison cannot be re-quoted as shown.'
                        : `was quoted at ${item.quotedRate}% and is now ${item.currentRate}% (${
                            item.changePercent! > 0 ? '+' : ''
                          }${item.changePercent}).`}
                    </p>
                  ))}
                </div>
              )}

              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[520px] text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-500)] [&>th]:px-3 [&>th:first-child]:pl-0 [&>th:last-child]:pr-0">
                      <th className="py-2 font-medium">Product</th>
                      <th className="py-2 text-right font-medium">Rate</th>
                      <th className="py-2 text-right font-medium">Payment</th>
                      <th className="py-2 text-right font-medium">Interest over term</th>
                      <th className="py-2 text-right font-medium">Balance at renewal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scenario.options.map((option) => (
                      <tr
                        key={option.productId}
                        className="border-b border-[var(--color-line)] last:border-0 [&>td]:px-3 [&>td:first-child]:pl-0 [&>td:last-child]:pr-0"
                      >
                        <td className="py-2">
                          <span className="font-medium">{option.lenderName}</span>
                          <span className="block text-[12px] text-[var(--color-ink-400)]">
                            {option.productName} · {option.termYears}y {option.rateType}
                            {!option.fits && ' · does not fit'}
                          </span>
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            {option.productId === scenario.cheapestOverTerm && (
                              <span className="badge badge-approved">Cheapest over the term</span>
                            )}
                            {option.productId === scenario.lowestPayment &&
                              option.productId !== scenario.cheapestOverTerm && (
                                <span className="badge badge-in_review">Lowest payment</span>
                              )}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums">{option.postedRate}%</td>
                        <td className="py-2 text-right tabular-nums">
                          {money(option.monthlyPayment)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {money(option.totalInterestOverTerm)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {money(option.balanceAtEndOfTerm)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {scenario.termsDiffer ? (
                <p className="field-hint">
                  These run for different terms ({scenario.termYears.map((y) => `${y}y`).join(' and ')}),
                  so the interest and renewal-balance columns cover different periods and no
                  cheapest is marked. Saying which costs less overall would mean assuming a renewal
                  rate at the earlier maturity, and nobody knows that number.
                </p>
              ) : (
                scenario.spreadOverTerm > 0 && (
                  <p className="field-hint">
                    {money(scenario.spreadOverTerm)} between the cheapest and the most expensive
                    over the term, counting interest paid and the balance left to renew.
                  </p>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
