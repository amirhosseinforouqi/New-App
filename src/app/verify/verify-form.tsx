'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function VerifyForm({ accountLabel }: { accountLabel: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: form.get('token') }),
      });

      const data = (await response.json()) as {
        redirect?: string;
        error?: string;
        signOut?: boolean;
        usedRecoveryCode?: boolean;
        recoveryCodesRemaining?: number;
      };

      if (!response.ok) {
        setError(data.error ?? 'That code is not right.');
        if (data.signOut) router.push('/login');
        return;
      }

      if (data.usedRecoveryCode) {
        // Warn before navigating away — this is the only moment they will
        // notice they are running out.
        const left = data.recoveryCodesRemaining ?? 0;
        if (left <= 2) {
          window.alert(
            `Recovery code accepted. You have ${left} left — generate a new set from your ` +
              'security settings.',
          );
        }
      }

      router.push(data.redirect ?? '/');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form method="post" onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div>
        <label className="label" htmlFor="token">
          {useRecovery ? 'Recovery code' : '6-digit code'}
        </label>
        <input
          id="token"
          name="token"
          className="input text-center font-mono text-lg tracking-[0.3em]"
          // A numeric keypad for digits, a normal keyboard for recovery codes.
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoComplete={useRecovery ? 'off' : 'one-time-code'}
          autoFocus
          required
          maxLength={useRecovery ? 13 : 6}
          placeholder={useRecovery ? 'XXXXX-XXXXX' : '000000'}
          aria-describedby="token-hint"
        />
        <p id="token-hint" className="field-hint">
          {useRecovery
            ? 'One of the codes you saved when you turned on two-factor authentication. Each works once.'
            : `From your authenticator app, for ${accountLabel}.`}
        </p>
      </div>

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? 'Checking…' : 'Verify'}
      </button>

      <button
        type="button"
        className="w-full text-[13px] text-[var(--color-ink-500)] underline underline-offset-2 hover:text-[var(--color-ink-900)]"
        onClick={() => {
          setUseRecovery((current) => !current);
          setError(null);
        }}
      >
        {useRecovery ? 'Use my authenticator app instead' : 'I don’t have my phone'}
      </button>
    </form>
  );
}
