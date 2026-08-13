'use client';

/**
 * API keys and webhook endpoints.
 *
 * Both secrets are shown exactly once. The UI is built around that rather than
 * apologising for it: the value appears in a block that has to be dismissed,
 * with a copy button, and the list afterwards shows only the prefix.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface KeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface HookRow {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
}

export function IntegrationsPanel({
  keys,
  hooks,
  events,
}: {
  keys: KeyRow[];
  hooks: HookRow[];
  events: readonly string[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ title: string; value: string; note: string } | null>(null);

  const [keyName, setKeyName] = useState('');
  const [keyWrite, setKeyWrite] = useState(false);
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>([]);

  async function post(body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/broker/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not work.');
        return null;
      }
      router.refresh();
      return data as Record<string, unknown>;
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setPending(false);
    }
  }

  if (reveal) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">{reveal.title}</h2>
        <div className="alert alert-warn mt-3">
          This is shown once and cannot be retrieved again. Copy it somewhere safe now.
        </div>

        <p className="mt-4 rounded-[var(--radius-control)] bg-[var(--color-canvas)] px-3 py-3 font-mono text-[13px] break-all">
          {reveal.value}
        </p>
        <p className="field-hint">{reveal.note}</p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void navigator.clipboard?.writeText(reveal.value)}
          >
            Copy
          </button>
          <button
            type="button"
            className="btn btn-primary flex-1"
            onClick={() => setReveal(null)}
          >
            I have saved it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {/* ── API keys ────────────────────────────────────────────────────── */}
      <section className="card p-5">
        <h2 className="text-sm font-semibold">API keys</h2>
        <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
          For Zapier, your CRM, or your own scripts. Read keys can list deals; write keys can
          also post leads.
        </p>

        {keys.length > 0 && (
          <ul className="mt-4 divide-y divide-[var(--color-line)]">
            {keys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-3 py-3 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {key.name}
                    {key.revokedAt && (
                      <span className="badge badge-needs_attention ml-2">Revoked</span>
                    )}
                  </p>
                  <p className="font-mono text-[12px] text-[var(--color-ink-400)]">
                    uwa_live_{key.keyPrefix}… · {key.scopes.join(', ')} ·{' '}
                    {key.lastUsedAt
                      ? `last used ${new Date(key.lastUsedAt).toLocaleDateString('en-CA')}`
                      : 'never used'}
                  </p>
                </div>
                {!key.revokedAt && (
                  <button
                    type="button"
                    className="btn btn-danger px-2.5 py-1 text-[13px]"
                    disabled={pending}
                    onClick={() => void post({ action: 'revoke_key', keyId: key.id })}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label className="label" htmlFor="key-name">
              New key name
            </label>
            <input
              id="key-name"
              className="input"
              value={keyName}
              maxLength={80}
              placeholder="Zapier"
              onChange={(event) => setKeyName(event.target.value)}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-2.5 text-[13px]">
            <input
              type="checkbox"
              checked={keyWrite}
              onChange={(event) => setKeyWrite(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent-700)]"
            />
            Allow writes
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || keyName.trim() === ''}
            onClick={async () => {
              const data = await post({
                action: 'create_key',
                name: keyName.trim(),
                scopes: keyWrite ? ['read', 'write'] : ['read'],
              });
              if (data?.key) {
                setReveal({
                  title: 'Your new API key',
                  value: String(data.key),
                  note: 'Send it as an Authorization: Bearer header.',
                });
                setKeyName('');
                setKeyWrite(false);
              }
            }}
          >
            Create key
          </button>
        </div>
      </section>

      {/* ── Webhooks ────────────────────────────────────────────────────── */}
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Webhooks</h2>
        <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
          We POST signed JSON when things happen. Verify the{' '}
          <code className="font-mono text-[12px]">X-UWA-Signature</code> header before trusting a
          payload.
        </p>

        {hooks.length > 0 && (
          <ul className="mt-4 divide-y divide-[var(--color-line)]">
            {hooks.map((hook) => (
              <li key={hook.id} className="flex flex-wrap items-center gap-3 py-3 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{hook.url}</p>
                  <p className="text-[12px] text-[var(--color-ink-400)]">
                    {hook.events.length === 0 ? 'all events' : hook.events.join(', ')}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-danger px-2.5 py-1 text-[13px]"
                  disabled={pending}
                  onClick={() => void post({ action: 'delete_webhook', webhookId: hook.id })}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4">
          <label className="label" htmlFor="hook-url">
            Endpoint URL
          </label>
          <input
            id="hook-url"
            className="input"
            value={hookUrl}
            placeholder="https://hooks.zapier.com/…"
            onChange={(event) => setHookUrl(event.target.value)}
          />
          <p className="field-hint">Must be https. We sign payloads but do not encrypt them.</p>
        </div>

        <fieldset className="mt-3">
          <legend className="label">Events (none selected means all)</legend>
          <div className="flex flex-wrap gap-2">
            {events.map((event) => {
              const selected = hookEvents.includes(event);
              return (
                <label
                  key={event}
                  className={
                    'cursor-pointer rounded-full border px-2.5 py-1 font-mono text-[12px] transition-colors ' +
                    (selected
                      ? 'border-[var(--color-accent-700)] bg-[var(--color-accent-100)] text-[var(--color-accent-700)]'
                      : 'border-[var(--color-line-strong)] text-[var(--color-ink-500)]')
                  }
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={selected}
                    onChange={() =>
                      setHookEvents((current) =>
                        current.includes(event)
                          ? current.filter((item) => item !== event)
                          : [...current, event],
                      )
                    }
                  />
                  {event}
                </label>
              );
            })}
          </div>
        </fieldset>

        <button
          type="button"
          className="btn btn-primary mt-4"
          disabled={pending || !hookUrl.startsWith('https://')}
          onClick={async () => {
            const data = await post({
              action: 'create_webhook',
              url: hookUrl.trim(),
              events: hookEvents,
            });
            if (data?.secret) {
              setReveal({
                title: 'Your webhook signing secret',
                value: String(data.secret),
                note: 'Compute HMAC-SHA256 over `{timestamp}.{body}` and compare to the v1 value in X-UWA-Signature.',
              });
              setHookUrl('');
              setHookEvents([]);
            }
          }}
        >
          Add endpoint
        </button>
      </section>
    </div>
  );
}
