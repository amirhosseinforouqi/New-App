'use client';

/**
 * Where the submission bar sits.
 *
 * Each rule can be blocking, a warning, or off. Locked rules show why instead
 * of showing controls — that is a deliberate piece of the interface rather than
 * a disabled button, because a greyed-out toggle reads as "ask an admin" and
 * this one is not going to be enabled by anyone.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface RuleRow {
  key: string;
  label: string;
  defaultSeverity: 'blocking' | 'warning';
  severity: 'blocking' | 'warning';
  enabled: boolean;
  locked: boolean;
  lockedReason: string | null;
  customised: boolean;
}

type Setting = 'blocking' | 'warning' | 'off';

const settingOf = (rule: RuleRow): Setting => (rule.enabled ? rule.severity : 'off');

const OPTIONS: Array<{ value: Setting; label: string; hint: string }> = [
  { value: 'blocking', label: 'Blocks submission', hint: 'The file cannot be sent until it is cleared.' },
  { value: 'warning', label: 'Warns only', hint: 'Shown on the file; the broker decides.' },
  { value: 'off', label: 'Off', hint: 'Not checked at all.' },
];

export function RulePanel({ rules, canEdit }: { rules: RuleRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch('/api/broker/rules', {
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

  function change(rule: RuleRow, setting: Setting) {
    void post(
      {
        action: 'set',
        ruleKey: rule.key,
        severity: setting === 'off' ? rule.severity : setting,
        enabled: setting !== 'off',
      },
      rule.key,
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {!canEdit && (
        <div className="alert alert-warn">
          Only an owner can change these. This is what your brokerage currently requires.
        </div>
      )}

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Before a file can go to a lender</h2>
        <p className="field-hint">
          Blocking rules stop the submission. Keep that list short — software that blocks on
          everything it dislikes gets worked around within a week, and then the checks that matter
          get ignored too.
        </p>

        <ul className="mt-4 divide-y divide-[var(--color-line)]">
          {rules.map((rule) => (
            <li key={rule.key} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {rule.label}
                    {rule.customised && (
                      <span className="ml-2 text-[12px] font-normal text-[var(--color-ink-400)]">
                        changed from default
                      </span>
                    )}
                  </p>
                  {rule.locked && rule.lockedReason && (
                    <p className="mt-1 max-w-prose text-[12px] text-[var(--color-ink-500)]">
                      {rule.lockedReason}
                    </p>
                  )}
                </div>

                {rule.locked ? (
                  <span className="badge badge-needs_attention shrink-0">Required by law</span>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      className="input w-44 py-1.5 text-[13px]"
                      aria-label={`Setting for ${rule.label}`}
                      value={settingOf(rule)}
                      disabled={!canEdit || pending === rule.key}
                      onChange={(event) => change(rule, event.target.value as Setting)}
                    >
                      {OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>

                    {rule.customised && canEdit && (
                      <button
                        type="button"
                        className="text-[12px] text-[var(--color-ink-400)] underline hover:text-[var(--color-ink-700)]"
                        disabled={pending === rule.key}
                        onClick={() => void post({ action: 'reset', ruleKey: rule.key }, rule.key)}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                )}
              </div>

              {!rule.locked && (
                <p className="mt-1 text-[12px] text-[var(--color-ink-400)]">
                  {OPTIONS.find((option) => option.value === settingOf(rule))?.hint}
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
