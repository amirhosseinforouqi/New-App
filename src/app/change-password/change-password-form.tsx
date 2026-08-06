'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const MIN_LENGTH = 12;

export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }

    setPending(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = (await response.json()) as { redirect?: string; error?: string };

      if (!response.ok) {
        setError(data.error ?? 'Could not change your password.');
        setPending(false);
        return;
      }

      router.push(data.redirect ?? '/dashboard');
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
      setPending(false);
    }
  }

  return (
    // See the note in login-form.tsx: method="post" stops a pre-hydration
    // submit from putting passwords in the query string.
    <form method="post" onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div>
        <label className="label" htmlFor="currentPassword">
          Temporary password
        </label>
        <input
          id="currentPassword"
          type="password"
          className="input"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <p className="field-hint">The one from your welcome email.</p>
      </div>

      <div>
        <label className="label" htmlFor="newPassword">
          New password
        </label>
        <input
          id="newPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          required
          minLength={MIN_LENGTH}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          aria-describedby="newPasswordHint"
        />
        <p id="newPasswordHint" className="field-hint">
          {tooShort
            ? `${MIN_LENGTH - newPassword.length} more character${
                MIN_LENGTH - newPassword.length === 1 ? '' : 's'
              } needed.`
            : `At least ${MIN_LENGTH} characters. A short phrase you will remember works well.`}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="confirmPassword">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        {mismatch && <p className="field-hint text-[var(--color-danger-600)]">These do not match.</p>}
      </div>

      <button
        type="submit"
        className="btn btn-primary w-full"
        disabled={pending || tooShort || mismatch || newPassword.length === 0}
      >
        {pending ? 'Saving…' : 'Save password'}
      </button>
    </form>
  );
}
