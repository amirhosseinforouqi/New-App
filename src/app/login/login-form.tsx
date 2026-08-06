'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function LoginForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });

      const data = (await response.json()) as { redirect?: string; error?: string };

      if (!response.ok) {
        setError(data.error ?? 'Sign in failed. Please try again.');
        setPending(false);
        return;
      }

      // Full navigation rather than router.push so server components re-read
      // the freshly-set session cookie.
      router.push(data.redirect ?? '/dashboard');
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setPending(false);
    }
  }

  return (
    // method="post" matters even though the submit is handled in JS: before
    // React hydrates (slow connection, a script error, a bot), a click still
    // submits the form natively. A form with no method defaults to GET, which
    // would put the password in the URL — and therefore in browser history,
    // the Referer header and access logs. POST keeps it in the body.
    <form method="post" onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <div>
        <label className="label" htmlFor="identifier">
          Username or email
        </label>
        <input
          id="identifier"
          name="identifier"
          className="input"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
