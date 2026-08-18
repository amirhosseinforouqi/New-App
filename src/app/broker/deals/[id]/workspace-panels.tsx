/**
 * Server-rendered panels for the deal page: submission readiness, the
 * compliance checklist, lender matches and cross-sell suggestions.
 *
 * All read-only. The interactive bits (ticking a compliance item, recording an
 * identity verification) live in their own client components so the bulk of
 * this page ships no JavaScript.
 */

import type { ProductMatch } from '@/lib/lenders/matching';
import type { SubmissionReadiness } from '@/lib/deals/validation';
import type { Workspace } from '@/lib/deals/workspace';
import { ComplianceControls } from './compliance-controls';

const money = (value: number) =>
  value.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

export function ReadinessPanel({ readiness }: { readiness: SubmissionReadiness }) {
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Ready for a lender?</h2>
        <span
          className={readiness.ready ? 'badge badge-approved' : 'badge badge-needs_attention'}
        >
          {readiness.ready ? 'Ready to submit' : `${readiness.blocking.length} blocking`}
        </span>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--color-line)]">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${readiness.completeness}%`,
            background: readiness.ready ? 'var(--color-ok-600)' : 'var(--color-warn-600)',
          }}
        />
      </div>
      <p className="field-hint">{readiness.completeness}% complete</p>

      {readiness.blocking.length > 0 && (
        <ul className="mt-4 space-y-2">
          {readiness.blocking.map((issue) => (
            <li key={issue.key} className="alert alert-error">
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {readiness.warnings.length > 0 && (
        <ul className="mt-2 space-y-2">
          {readiness.warnings.map((issue) => (
            <li key={issue.key} className="alert alert-warn">
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {readiness.ready && readiness.warnings.length === 0 && (
        <p className="alert alert-ok mt-4">
          Nothing outstanding. Documents in, compliance recorded, consents signed.
        </p>
      )}
    </section>
  );
}

export function LenderPanel({ matches }: { matches: ProductMatch[] }) {
  const fitting = matches.filter((match) => match.fits);
  const failing = matches.filter((match) => !match.fits);

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Lender products</h2>
        {matches.length > 0 && (
          <span className="text-[13px] text-[var(--color-ink-500)]">
            {fitting.length} of {matches.length} fit
          </span>
        )}
      </div>

      {matches.length === 0 ? (
        <p className="field-hint mt-2">
          No products in your table yet, or the file has no mortgage amount. Add the lenders you
          place business with in{' '}
          <a href="/settings/lenders" className="underline">
            lender settings
          </a>
          .
        </p>
      ) : (
        <>
          {fitting.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-500)]">
                    <th className="py-2 font-medium">Lender</th>
                    <th className="py-2 text-right font-medium">Rate</th>
                    <th className="py-2 text-right font-medium">Payment</th>
                    <th className="py-2 text-right font-medium">Interest over term</th>
                    <th className="py-2 text-right font-medium">Balance at renewal</th>
                  </tr>
                </thead>
                <tbody>
                  {fitting.map((match) => (
                    <tr
                      key={match.product.id}
                      className="border-b border-[var(--color-line)] last:border-0"
                    >
                      <td className="py-2">
                        <span className="font-medium">{match.product.lenderName}</span>
                        <span className="block text-[12px] text-[var(--color-ink-400)]">
                          {match.product.name}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{match.product.postedRate}%</td>
                      <td className="py-2 text-right tabular-nums">
                        {money(match.monthlyPayment)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[var(--color-ink-500)]">
                        {money(match.totalInterestOverTerm)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {money(match.balanceAtEndOfTerm)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="field-hint">
                Ranked by cost over the term, not by headline rate — a lower rate on a shorter
                term can leave a larger balance to renew.
              </p>
            </div>
          )}

          {failing.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-[13px] font-semibold text-[var(--color-ink-500)]">
                {failing.length} that do not fit, and why
              </summary>
              <ul className="mt-3 space-y-3">
                {failing.map((match) => (
                  <li key={match.product.id}>
                    <p className="text-[13px] font-medium">
                      {match.product.lenderName} · {match.product.name}
                    </p>
                    <ul className="mt-1 space-y-1">
                      {match.failures.map((failure) => (
                        <li
                          key={failure.rule}
                          className={
                            'text-[13px] ' +
                            (failure.actionable
                              ? 'text-[var(--color-warn-600)]'
                              : 'text-[var(--color-ink-400)]')
                          }
                        >
                          {failure.actionable ? '→ ' : '· '}
                          {failure.detail}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <p className="field-hint">
                Arrows mark things you could change. Dots are hard limits.
              </p>
            </details>
          )}
        </>
      )}
    </section>
  );
}

export function CrossSellPanel({ suggestions }: { suggestions: Workspace['crossSell'] }) {
  const open = suggestions.filter((item) => item.status !== 'dismissed');
  if (open.length === 0) return null;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold">Worth mentioning</h2>
      <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
        Screened from this file. Nothing is sent to the client automatically.
      </p>

      <ul className="mt-4 space-y-3">
        {open.map((item) => (
          <li key={item.productKey} className="border-l-2 border-[var(--color-accent-500)] pl-3">
            <p className="text-[13px] font-semibold">{item.label}</p>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-500)]">
              {item.rationale}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CompliancePanel({
  dealId,
  items,
  borrowers,
  documents,
  identityByClient,
  consentByClient,
}: {
  dealId: string;
  items: Workspace['compliance'];
  borrowers: Array<{ clientId: string; fullName: string }>;
  documents: Array<{ id: string; fileName: string }>;
  identityByClient: Map<string, boolean>;
  consentByClient: Map<string, boolean>;
}) {
  const done = items.filter((item) => item.status === 'complete').length;

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Compliance</h2>
        <span className="text-[13px] text-[var(--color-ink-500)]">
          {done} of {items.length} complete
        </span>
      </div>

      {items.length === 0 ? (
        <p className="field-hint mt-2">
          No checklist yet. It is created from the FINTRAC template the first time this page
          loads for a deal with borrowers.
        </p>
      ) : (
        <div className="mt-4">
          <ComplianceControls
            dealId={dealId}
            items={items.map((item) => ({
              id: item.id,
              label: item.label,
              description: item.description,
              requiresDocument: item.requiresDocument,
              status: item.status,
              documentId: item.documentId,
            }))}
            borrowers={borrowers.map((borrower) => ({
              ...borrower,
              identityVerified: identityByClient.get(borrower.clientId) ?? false,
            }))}
            documents={documents}
          />
        </div>
      )}

      <div className="mt-4 border-t border-[var(--color-line)] pt-4">
        <p className="label">Consent status</p>
        <ul className="space-y-1.5">
          {borrowers.map((borrower) => (
            <li key={borrower.clientId} className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium">{borrower.fullName}</span>
              <span
                className={
                  consentByClient.get(borrower.clientId)
                    ? 'badge badge-approved'
                    : 'badge badge-requested'
                }
              >
                {consentByClient.get(borrower.clientId) ? 'Consent signed' : 'Consent outstanding'}
              </span>
            </li>
          ))}
        </ul>
        <p className="field-hint">
          Consents are signed by the borrower in their own portal. You cannot sign on their
          behalf.
        </p>
      </div>
    </section>
  );
}
