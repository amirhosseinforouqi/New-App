'use client';

/**
 * Bank, CRA and bureau verification.
 *
 * There is no "Connect bank account" button here, because pressing it would do
 * nothing. Bank aggregation, CRA data and a bureau pull each need a vendor
 * agreement the brokerage buys, and a disabled button implying otherwise is
 * worse than an honest sentence.
 *
 * What the panel does is record the route that actually exists today — the
 * borrower uploads it, or the broker pulls it through the brokerage's own
 * bureau access — so the file shows what was asked for and what came back. The
 * vendor note stays visible so the gap is a known gap rather than a missing
 * feature someone rediscovers in a demo.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ConnectionRecordView {
  id: string;
  clientId: string;
  kind: string;
  provider: string;
  status: string;
  detail: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface ConnectionKindView {
  key: string;
  label: string;
  purpose: string;
  manualRoute: string;
  vendorRoute: string | null;
  requiresConsent: boolean;
  records: ConnectionRecordView[];
  outstandingFor: string[];
}

export interface BorrowerView {
  clientId: string;
  fullName: string;
  consentSigned: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  requested: 'Asked for',
  received: 'Received',
  declined: 'Declined',
  unavailable: 'Not available',
};

const STATUS_CLASS: Record<string, string> = {
  requested: 'badge-requested',
  received: 'badge-approved',
  declined: 'badge-needs_attention',
  unavailable: 'badge-requested',
};

export function ConnectionsPanel({
  dealId,
  kinds,
  borrowers,
}: {
  dealId: string;
  kinds: ConnectionKindView[];
  borrowers: BorrowerView[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch(`/api/broker/deals/${dealId}/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not work.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold">Bank, CRA and bureau</h2>
      <p className="field-hint">
        What has been asked for and what has come back. These are recorded, not fetched — each one
        needs an agreement with the provider, and the note under each says which.
      </p>

      {error && (
        <div className="alert alert-error mt-3" role="alert">
          {error}
        </div>
      )}

      <ul className="mt-3 divide-y divide-[var(--color-line)]">
        {kinds.map((kind) => {
          const isOpen = expanded === kind.key;

          return (
            <li key={kind.key} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <button
                  type="button"
                  className="text-[13px] font-medium hover:underline"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : kind.key)}
                >
                  {isOpen ? '▾' : '▸'} {kind.label}
                </button>
                <span className="text-[12px] text-[var(--color-ink-500)]">
                  {kind.outstandingFor.length === 0
                    ? 'complete'
                    : `${kind.outstandingFor.length} of ${borrowers.length} outstanding`}
                </span>
              </div>

              {isOpen && (
                <div className="mt-2">
                  <p className="text-[12px] text-[var(--color-ink-500)]">{kind.purpose}</p>

                  <p className="mt-2 text-[12px] text-[var(--color-ink-500)]">
                    <strong className="font-medium text-[var(--color-ink-700)]">Today:</strong>{' '}
                    {kind.manualRoute}
                  </p>

                  <p className="mt-1.5 text-[12px] text-[var(--color-ink-400)]">
                    <strong className="font-medium">If you buy an integration:</strong>{' '}
                    {kind.vendorRoute ??
                      'There is nothing to buy — the CRA has no API a brokerage can call. The download is the route.'}
                  </p>

                  <div className="mt-3 space-y-2">
                    {borrowers.map((borrower) => {
                      const records = kind.records.filter(
                        (record) => record.clientId === borrower.clientId,
                      );
                      const latest = records[0];
                      const blocked = kind.requiresConsent && !borrower.consentSigned;
                      const key = `${kind.key}:${borrower.clientId}`;

                      return (
                        <div
                          key={borrower.clientId}
                          className="rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[13px]">{borrower.fullName}</span>
                            {latest && (
                              <span className={`badge ${STATUS_CLASS[latest.status] ?? ''}`}>
                                {STATUS_LABEL[latest.status] ?? latest.status}
                                {latest.provider !== 'manual' && ` · ${latest.provider}`}
                              </span>
                            )}
                          </div>

                          {blocked ? (
                            <p className="mt-1 text-[12px] text-[var(--color-warn-600)]">
                              Needs the borrower&rsquo;s signed consent first.
                            </p>
                          ) : (
                            <div className="mt-1.5 flex flex-wrap gap-2">
                              {(['requested', 'received', 'declined'] as const).map((status) => (
                                <button
                                  key={status}
                                  type="button"
                                  className="text-[12px] text-[var(--color-accent-700)] hover:underline disabled:opacity-40"
                                  disabled={pending === key || latest?.status === status}
                                  onClick={() =>
                                    void post(
                                      {
                                        action: 'record',
                                        clientId: borrower.clientId,
                                        kind: kind.key,
                                        status,
                                      },
                                      key,
                                    )
                                  }
                                >
                                  Mark {STATUS_LABEL[status]!.toLowerCase()}
                                </button>
                              ))}
                            </div>
                          )}

                          {records.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5 text-[12px] text-[var(--color-ink-400)]">
                              {records.slice(0, 3).map((record) => (
                                <li key={record.id}>
                                  {STATUS_LABEL[record.status] ?? record.status} on{' '}
                                  {new Date(record.requestedAt).toLocaleDateString('en-CA')}
                                  {record.detail && ` — ${record.detail}`}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
