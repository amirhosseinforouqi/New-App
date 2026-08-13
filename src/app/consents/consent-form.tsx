'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ConsentCard {
  kind: string;
  title: string;
  body: string;
  required: boolean;
  signedAt: string | null;
  signedName: string | null;
}

export function ConsentList({
  consents,
  dealId,
  fullName,
}: {
  consents: ConsentCard[];
  dealId: string;
  fullName: string;
}) {
  return (
    <div className="space-y-5">
      {consents.map((consent) => (
        <ConsentItem key={consent.kind} consent={consent} dealId={dealId} fullName={fullName} />
      ))}
    </div>
  );
}

function ConsentItem({
  consent,
  dealId,
  fullName,
}: {
  consent: ConsentCard;
  dealId: string;
  fullName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signedName, setSignedName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signed = consent.signedAt !== null;

  async function sign() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: consent.kind, dealId, signedName, agreed: true }),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'That did not save.');
        return;
      }

      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{consent.title}</h2>
          {signed ? (
            <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
              Signed by {consent.signedName} on{' '}
              {new Date(consent.signedAt!).toLocaleDateString('en-CA', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          ) : (
            <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
              {consent.required
                ? 'Needed before your file can go to a lender.'
                : 'Optional — we record your decision either way.'}
            </p>
          )}
        </div>
        <span className={signed ? 'badge badge-approved' : 'badge badge-requested'}>
          {signed ? 'Signed' : consent.required ? 'Required' : 'Optional'}
        </span>
      </div>

      <button
        type="button"
        className="mt-3 text-[13px] font-semibold text-[var(--color-accent-600)] hover:underline"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {open ? 'Hide the wording' : signed ? 'Read what you signed' : 'Read it'}
      </button>

      {open && (
        <div className="mt-3 max-h-80 overflow-y-auto rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-4">
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--color-ink-700)]">
            {consent.body}
          </p>
        </div>
      )}

      {!signed && (
        <div className="mt-4 border-t border-[var(--color-line)] pt-4">
          {error && (
            <div className="alert alert-error mb-3" role="alert">
              {error}
            </div>
          )}

          <label className="label" htmlFor={`sign-${consent.kind}`}>
            Type your full name to sign
          </label>
          <input
            id={`sign-${consent.kind}`}
            className="input"
            value={signedName}
            maxLength={200}
            placeholder={fullName}
            autoComplete="name"
            onChange={(event) => setSignedName(event.target.value)}
          />

          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent-700)]"
            />
            I have read this and I agree to it. I understand that typing my name here is my
            signature.
          </label>

          <button
            type="button"
            className="btn btn-primary mt-4"
            disabled={pending || !agreed || signedName.trim().length < 2}
            onClick={() => void sign()}
          >
            {pending ? 'Signing…' : 'Sign'}
          </button>

          <p className="field-hint">
            We record the date, your IP address and a fingerprint of this exact wording, so
            what you agreed to can be shown later.
          </p>
        </div>
      )}
    </section>
  );
}
