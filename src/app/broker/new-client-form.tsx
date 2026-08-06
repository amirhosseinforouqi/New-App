'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const APPLICATION_TYPES = [
  { value: 'purchase', label: 'Purchase' },
  { value: 'refinance', label: 'Refinance' },
  { value: 'renewal', label: 'Renewal' },
  { value: 'construction', label: 'Construction' },
  { value: 'heloc', label: 'HELOC' },
  { value: 'commercial', label: 'Commercial' },
] as const;

export function NewClientForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ username: string; warnings: string[] } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch('/api/broker/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: form.get('fullName'),
          email: form.get('email'),
          applicationType: form.get('applicationType'),
          phone: form.get('phone') || undefined,
          notes: form.get('notes') || undefined,
        }),
      });

      const data = (await response.json()) as {
        username?: string;
        warnings?: string[];
        error?: string;
      };

      if (!response.ok) {
        setError(data.error ?? 'Could not create the client.');
        setPending(false);
        return;
      }

      setResult({ username: data.username ?? '', warnings: data.warnings ?? [] });
      event.currentTarget.reset();
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        Add client
      </button>
    );
  }

  return (
    <div className="card w-full max-w-md p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Add a client</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            They get a Drive folder, a checklist and their login details by email.
          </p>
        </div>
        <button
          type="button"
          className="text-sm text-[var(--color-ink-400)] hover:text-[var(--color-ink-700)]"
          onClick={() => {
            setOpen(false);
            setResult(null);
            setError(null);
          }}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {result ? (
        <div className="space-y-3">
          <div className="alert alert-ok">
            Client created. Their username is <strong>{result.username}</strong> and their login
            details are on the way.
          </div>
          {result.warnings.map((warning) => (
            <div key={warning} className="alert alert-warn">
              {warning}
            </div>
          ))}
          <button
            type="button"
            className="btn btn-secondary w-full"
            onClick={() => setResult(null)}
          >
            Add another
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}

          <div>
            <label className="label" htmlFor="fullName">
              Full name
            </label>
            <input id="fullName" name="fullName" className="input" required maxLength={200} />
          </div>

          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input id="email" name="email" type="email" className="input" required />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="applicationType">
                Application type
              </label>
              <select id="applicationType" name="applicationType" className="input">
                {APPLICATION_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="phone">
                Phone <span className="font-normal text-[var(--color-ink-400)]">(optional)</span>
              </label>
              <input id="phone" name="phone" className="input" maxLength={40} />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="notes">
              Notes for the checklist agent{' '}
              <span className="font-normal text-[var(--color-ink-400)]">(optional)</span>
            </label>
            <textarea
              id="notes"
              name="notes"
              className="input min-h-[64px]"
              maxLength={2000}
              placeholder="e.g. self-employed, incorporated 2019; buying with a co-applicant"
            />
            <p className="field-hint">
              Anything here shapes the generated document list — employment type is the most
              useful thing to mention.
            </p>
          </div>

          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? 'Creating…' : 'Create and send login details'}
          </button>
        </form>
      )}
    </div>
  );
}
