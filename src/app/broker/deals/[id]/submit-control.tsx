'use client';

/**
 * Building and downloading the lender submission package.
 *
 * The button is disabled while blocking issues remain — but the server refuses
 * independently, because a disabled button is a suggestion and this is a rule.
 * Warnings require an explicit acknowledgement rather than being silently
 * bypassed, so a broker who sends a file with a stretched TDS has said so.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface LenderOption {
  id: string;
  name: string;
  products: Array<{ id: string; name: string; rate: number }>;
}

export function SubmitControl({
  dealId,
  reference,
  ready,
  blockingCount,
  warningCount,
  lenders,
  lastSubmittedAt,
}: {
  dealId: string;
  reference: string;
  ready: boolean;
  blockingCount: number;
  warningCount: number;
  lenders: LenderOption[];
  lastSubmittedAt: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lenderId, setLenderId] = useState(lenders[0]?.id ?? '');
  const [productId, setProductId] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const products = lenders.find((lender) => lender.id === lenderId)?.products ?? [];

  async function submit() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/broker/deals/${dealId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lenderId: lenderId || null,
          productId: productId || null,
          method: 'export',
          acknowledgeWarnings: acknowledged,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(
          [data.error, ...(data.blocking ?? []), ...(data.warnings ?? [])]
            .filter(Boolean)
            .join(' · '),
        );
        return;
      }

      // Hand the package over as a file. The viewer's own browser does the
      // download; nothing is written server-side beyond the audit row.
      const blob = new Blob([JSON.stringify(data.payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${reference}-submission.json`;
      anchor.click();
      URL.revokeObjectURL(url);

      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Send to a lender</h2>
        {lastSubmittedAt && (
          <span className="text-[13px] text-[var(--color-ink-500)]">
            Last sent {new Date(lastSubmittedAt).toLocaleDateString('en-CA')}
          </span>
        )}
      </div>

      {error && (
        <div className="alert alert-error mt-3" role="alert">
          {error}
        </div>
      )}

      {!ready ? (
        <p className="field-hint mt-2">
          {blockingCount} blocking issue{blockingCount === 1 ? '' : 's'} above. Clear
          {blockingCount === 1 ? ' it' : ' them'} first.
        </p>
      ) : !open ? (
        <>
          <button type="button" className="btn btn-primary mt-3" onClick={() => setOpen(true)}>
            Build the submission package
          </button>
          <p className="field-hint">
            Downloads the full file as JSON for the lender&rsquo;s portal. This is an export, not a
            direct submission — a two-way bridge needs an integration agreement with each lender.
          </p>
        </>
      ) : (
        <div className="mt-3">
          {lenders.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="submit-lender">
                  Lender
                </label>
                <select
                  id="submit-lender"
                  className="input"
                  value={lenderId}
                  onChange={(event) => {
                    setLenderId(event.target.value);
                    setProductId('');
                  }}
                >
                  <option value="">Not decided yet</option>
                  {lenders.map((lender) => (
                    <option key={lender.id} value={lender.id}>
                      {lender.name}
                    </option>
                  ))}
                </select>
              </div>

              {products.length > 0 && (
                <div>
                  <label className="label" htmlFor="submit-product">
                    Product
                  </label>
                  <select
                    id="submit-product"
                    className="input"
                    value={productId}
                    onChange={(event) => setProductId(event.target.value)}
                  >
                    <option value="">Not decided yet</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name} — {product.rate}%
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {warningCount > 0 && (
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px]">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent-700)]"
              />
              There {warningCount === 1 ? 'is 1 warning' : `are ${warningCount} warnings`} on this
              file. I have read them and want to send it anyway.
            </label>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary flex-1"
              disabled={pending || (warningCount > 0 && !acknowledged)}
              onClick={() => void submit()}
            >
              {pending ? 'Building…' : 'Download package'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
