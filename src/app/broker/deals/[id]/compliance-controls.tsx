'use client';

/**
 * The interactive half of the compliance panel: ticking items, recording a
 * FINTRAC identity verification, and copying the deal.
 *
 * The server refuses to complete an item that needs a document without one, so
 * this shows the reason it came back rather than trying to predict it. Keeping
 * the rule in one place — the endpoint — means the UI cannot drift away from
 * what is actually enforced.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ComplianceItemView {
  id: string;
  label: string;
  description: string | null;
  requiresDocument: boolean;
  status: string;
  documentId: string | null;
}

export interface BorrowerView {
  clientId: string;
  fullName: string;
  identityVerified: boolean;
}

export interface DocumentOption {
  id: string;
  fileName: string;
}

const IDENTITY_METHODS = [
  { value: 'government_id', label: 'Government-issued photo ID' },
  { value: 'credit_file', label: 'Credit file method' },
  { value: 'dual_process', label: 'Dual process method' },
  { value: 'agent_mandate', label: 'Agent or mandatary' },
];

export function ComplianceControls({
  dealId,
  items,
  borrowers,
  documents,
}: {
  dealId: string;
  items: ComplianceItemView[];
  borrowers: BorrowerView[];
  documents: DocumentOption[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [attachTo, setAttachTo] = useState<Record<string, string>>({});

  async function post(body: Record<string, unknown>, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch(`/api/broker/deals/${dealId}/compliance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not save.');
        return null;
      }

      router.refresh();
      return data as Record<string, unknown>;
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <ul className="divide-y divide-[var(--color-line)]">
        {items.map((item) => {
          const complete = item.status === 'complete';
          const needsAttachment = item.requiresDocument && !item.documentId && !complete;

          return (
            <li key={item.id} className="py-2.5">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`item-${item.id}`}
                  checked={complete}
                  disabled={pending === item.id}
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent-700)]"
                  onChange={(event) =>
                    void post(
                      {
                        action: 'set_item',
                        itemId: item.id,
                        complete: event.target.checked,
                        documentId: attachTo[item.id] || item.documentId || null,
                      },
                      item.id,
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={`item-${item.id}`}
                    className={
                      'cursor-pointer text-[13px] font-medium ' +
                      (complete ? 'text-[var(--color-ink-400)] line-through' : '')
                    }
                  >
                    {item.label}
                  </label>
                  {item.description && !complete && (
                    <p className="text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                      {item.description}
                    </p>
                  )}

                  {needsAttachment && documents.length > 0 && (
                    <select
                      className="input mt-2 text-[13px]"
                      value={attachTo[item.id] ?? ''}
                      onChange={(event) =>
                        setAttachTo((current) => ({ ...current, [item.id]: event.target.value }))
                      }
                      aria-label={`Attach a document to ${item.label}`}
                    >
                      <option value="">Attach a document…</option>
                      {documents.map((document) => (
                        <option key={document.id} value={document.id}>
                          {document.fileName}
                        </option>
                      ))}
                    </select>
                  )}

                  {needsAttachment && documents.length === 0 && (
                    <p className="field-hint">
                      Needs a document. Nothing has been uploaded to this deal yet.
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-[var(--color-line)] pt-4">
        <p className="label">FINTRAC identity verification</p>

        {borrowers.map((borrower) => (
          <div key={borrower.clientId} className="mb-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{borrower.fullName}</span>
              {borrower.identityVerified ? (
                <span className="badge badge-approved">Verified</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary px-2.5 py-1 text-[13px]"
                  onClick={() =>
                    setVerifying(verifying === borrower.clientId ? null : borrower.clientId)
                  }
                >
                  Record verification
                </button>
              )}
            </div>

            {verifying === borrower.clientId && (
              <IdentityForm
                pending={pending === borrower.clientId}
                onCancel={() => setVerifying(null)}
                onSubmit={async (values) => {
                  const result = await post(
                    { action: 'verify_identity', clientId: borrower.clientId, ...values },
                    borrower.clientId,
                  );
                  if (result) setVerifying(null);
                }}
              />
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-[var(--color-line)] pt-4">
        <button
          type="button"
          className="btn btn-secondary w-full"
          disabled={pending === 'copy'}
          onClick={async () => {
            const result = await post({ action: 'copy_deal' }, 'copy');
            if (result?.dealId) router.push(`/broker/deals/${result.dealId}`);
          }}
        >
          {pending === 'copy' ? 'Copying…' : 'Copy this deal for repeat business'}
        </button>
        <p className="field-hint">
          Same borrowers and property facts, fresh pipeline. Documents, compliance and messages
          are not carried over — a new application needs its own evidence.
        </p>
      </div>
    </div>
  );
}

function IdentityForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [method, setMethod] = useState('government_id');
  const [documentType, setDocumentType] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [expiry, setExpiry] = useState('');
  const [pepScreened, setPepScreened] = useState(false);
  const [pepResult, setPepResult] = useState('no_match');

  const isPhotoId = method === 'government_id';

  return (
    <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-3.5">
      <label className="label" htmlFor="id-method">
        Method
      </label>
      <select
        id="id-method"
        className="input text-[13px]"
        value={method}
        onChange={(event) => setMethod(event.target.value)}
      >
        {IDENTITY_METHODS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {isPhotoId && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            className="input text-[13px]"
            placeholder="Document type (e.g. driver’s licence)"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value)}
            aria-label="Document type"
          />
          <input
            className="input text-[13px]"
            placeholder="Document number"
            value={documentNumber}
            onChange={(event) => setDocumentNumber(event.target.value)}
            aria-label="Document number"
          />
          <input
            className="input text-[13px]"
            placeholder="Issuing jurisdiction (e.g. ON)"
            value={jurisdiction}
            onChange={(event) => setJurisdiction(event.target.value)}
            aria-label="Issuing jurisdiction"
          />
          <input
            className="input text-[13px]"
            type="date"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            aria-label="Document expiry"
          />
        </div>
      )}

      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px]">
        <input
          type="checkbox"
          checked={pepScreened}
          onChange={(event) => setPepScreened(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent-700)]"
        />
        I have screened this person for politically exposed person status
      </label>

      {pepScreened && (
        <select
          className="input mt-2 text-[13px]"
          value={pepResult}
          onChange={(event) => setPepResult(event.target.value)}
          aria-label="Screening result"
        >
          <option value="no_match">No match</option>
          <option value="pep">PEP — senior management approval required</option>
          <option value="hio">Head of an international organisation</option>
          <option value="family_or_associate">Family member or close associate</option>
        </select>
      )}

      <p className="field-hint">
        Screening is done by you against your provider. This records the result and who
        recorded it — it does not perform the search.
      </p>

      <div className="mt-3 flex gap-2">
        <button type="button" className="btn btn-secondary px-3 py-1.5 text-[13px]" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary flex-1 px-3 py-1.5 text-[13px]"
          disabled={pending}
          onClick={() =>
            onSubmit({
              method,
              documentType: documentType || undefined,
              documentNumber: documentNumber || undefined,
              issuingJurisdiction: jurisdiction || undefined,
              documentExpiry: expiry || undefined,
              pepScreened,
              pepResult: pepScreened ? pepResult : undefined,
            })
          }
        >
          {pending ? 'Saving…' : 'Record verification'}
        </button>
      </div>
    </div>
  );
}
