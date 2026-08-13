'use client';

/**
 * Turning two-factor authentication on and off.
 *
 * The recovery codes are shown exactly once, at confirmation, and the UI makes
 * that unmissable — they cannot be fetched again, so a panel that displayed
 * them casually alongside everything else would leave people assuming they
 * could come back for them.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

type Stage = 'idle' | 'scanning' | 'codes' | 'disabling' | 'regenerating';

export function SecurityPanel({ enabled: initialEnabled, recoveryCodesRemaining }: Props) {
  const router = useRouter();

  const [enabled, setEnabled] = useState(initialEnabled);
  const [remaining, setRemaining] = useState(recoveryCodesRemaining);
  const [stage, setStage] = useState<Stage>('idle');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [secret, setSecret] = useState('');
  const [qrSvg, setQrSvg] = useState('');
  const [token, setToken] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);

  async function post(body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not work.');
        return null;
      }
      return data as Record<string, unknown>;
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setPending(false);
    }
  }

  async function begin() {
    const data = await post({ action: 'begin' });
    if (!data) return;

    setSecret(String(data.secret ?? ''));

    // Rendered server-side as SVG: the CSP forbids external images, so an
    // api.qrserver.com URL would silently fail. The endpoint takes no
    // parameters and rebuilds the URI from our own stored secret — echoing a
    // caller-supplied string into a QR the user is told to scan would be a
    // phishing primitive.
    const response = await fetch('/api/auth/mfa/qr');
    setQrSvg(response.ok ? await response.text() : '');

    setToken('');
    setStage('scanning');
  }

  async function confirm() {
    const data = await post({ action: 'confirm', token });
    if (!data) return;

    setCodes((data.recoveryCodes as string[]) ?? []);
    setAcknowledged(false);
    setEnabled(true);
    setStage('codes');
    router.refresh();
  }

  async function disable() {
    const data = await post({ action: 'disable', token });
    if (!data) return;

    // Disabling revokes every session, including this one.
    router.push('/login');
    router.refresh();
  }

  async function regenerate() {
    const data = await post({ action: 'regenerate', token });
    if (!data) return;

    const fresh = (data.recoveryCodes as string[]) ?? [];
    setCodes(fresh);
    setRemaining(fresh.length);
    setAcknowledged(false);
    setStage('codes');
  }

  // ── Recovery codes, shown once ─────────────────────────────────────────────
  if (stage === 'codes') {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">Save your recovery codes</h2>
        <div className="alert alert-warn mt-3">
          This is the only time these are shown. Store them somewhere safe — without your phone,
          they are the only way back into your account.
        </div>

        <ul className="mt-4 grid grid-cols-2 gap-2">
          {codes.map((code) => (
            <li
              key={code}
              className="rounded-[var(--radius-control)] bg-[var(--color-canvas)] px-3 py-2 text-center font-mono text-[13px]"
            >
              {code}
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}
          >
            Copy all
          </button>
        </div>

        <label className="mt-5 flex cursor-pointer items-start gap-2.5 text-[13px]">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent-700)]"
          />
          I have saved these codes somewhere I can get to without my phone.
        </label>

        <button
          type="button"
          className="btn btn-primary mt-4 w-full"
          disabled={!acknowledged}
          onClick={() => {
            setCodes([]);
            setToken('');
            setStage('idle');
            router.refresh();
          }}
        >
          Done
        </button>
      </div>
    );
  }

  // ── Scanning ───────────────────────────────────────────────────────────────
  if (stage === 'scanning') {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">Scan this with your authenticator</h2>
        <p className="field-hint">
          Google Authenticator, 1Password, Authy — any of them. Then enter the 6-digit code it
          shows.
        </p>

        {error && (
          <div className="alert alert-error mt-3" role="alert">
            {error}
          </div>
        )}

        {qrSvg ? (
          <div
            className="mx-auto mt-4 w-[200px] [&>svg]:h-auto [&>svg]:w-full"
            // Server-generated SVG from our own endpoint, built from a URI we
            // constructed — no user input reaches it.
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        ) : (
          <p className="field-hint mt-4">
            Could not draw the QR code — enter the key below by hand instead.
          </p>
        )}

        <div className="mt-4">
          <p className="label">Or type this key in</p>
          <p className="rounded-[var(--radius-control)] bg-[var(--color-canvas)] px-3 py-2 text-center font-mono text-[13px] break-all">
            {secret}
          </p>
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="confirm-token">
            6-digit code
          </label>
          <input
            id="confirm-token"
            className="input text-center font-mono text-lg tracking-[0.3em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="000000"
          />
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setStage('idle');
              setError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary flex-1"
            disabled={pending || token.length < 6}
            onClick={() => void confirm()}
          >
            {pending ? 'Checking…' : 'Turn on two-factor'}
          </button>
        </div>
      </div>
    );
  }

  // ── Confirming a destructive change ────────────────────────────────────────
  if (stage === 'disabling' || stage === 'regenerating') {
    const isDisabling = stage === 'disabling';

    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">
          {isDisabling ? 'Turn off two-factor authentication' : 'Generate new recovery codes'}
        </h2>
        <p className="field-hint">
          {isDisabling
            ? 'Enter a current code to confirm. This signs you out everywhere.'
            : 'Enter a current code to confirm. Your existing codes stop working.'}
        </p>

        {error && (
          <div className="alert alert-error mt-3" role="alert">
            {error}
          </div>
        )}

        <input
          className="input mt-4 text-center font-mono text-lg tracking-[0.3em]"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={13}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="000000"
          aria-label="Current code"
        />

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setStage('idle');
              setToken('');
              setError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={isDisabling ? 'btn btn-danger flex-1' : 'btn btn-primary flex-1'}
            disabled={pending || token.length < 6}
            onClick={() => void (isDisabling ? disable() : regenerate())}
          >
            {pending ? 'Checking…' : isDisabling ? 'Turn it off' : 'Generate new codes'}
          </button>
        </div>
      </div>
    );
  }

  // ── Idle ───────────────────────────────────────────────────────────────────
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Two-factor authentication</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            {enabled
              ? 'On. A code from your authenticator is required every time you sign in.'
              : 'Off. Your password is the only thing protecting your file.'}
          </p>
        </div>
        <span className={enabled ? 'badge badge-approved' : 'badge badge-needs_attention'}>
          {enabled ? 'On' : 'Off'}
        </span>
      </div>

      {error && (
        <div className="alert alert-error mt-3" role="alert">
          {error}
        </div>
      )}

      {enabled && remaining <= 2 && (
        <div className="alert alert-warn mt-3">
          Only {remaining} recovery code{remaining === 1 ? '' : 's'} left. Generate a new set
          before you run out.
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {enabled ? (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setToken('');
                setStage('regenerating');
              }}
            >
              New recovery codes ({remaining} left)
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setToken('');
                setStage('disabling');
              }}
            >
              Turn off
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() => void begin()}
          >
            {pending ? 'Setting up…' : 'Turn on two-factor'}
          </button>
        )}
      </div>
    </div>
  );
}
