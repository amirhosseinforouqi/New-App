'use client';

/**
 * Stage control — the manual gate.
 *
 * Only stages returned by `allowedTransitions` are offered, so the UI cannot
 * request a jump the API would reject. The API re-checks anyway; this just
 * means the broker never sees an error they could not have avoided.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { STAGES, allowedTransitions, getStage, stageIndex } from '@/lib/pipeline/stages';

interface HistoryEntry {
  stageKey: string;
  note: string | null;
  createdAt: string;
}

export function StageController({
  clientId,
  currentStageKey,
  history,
}: {
  clientId: string;
  currentStageKey: string;
  history: HistoryEntry[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowed = allowedTransitions(currentStageKey);
  const currentIndex = stageIndex(currentStageKey);
  const nextStage = STAGES[currentIndex + 1];

  async function advance(stageKey: string) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/broker/clients/${clientId}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageKey, note: note.trim() || undefined, notifyClient: notify }),
      });

      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(data.error ?? 'Could not update the stage.');
        setPending(false);
        return;
      }

      setTarget(null);
      setNote('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card p-5" aria-labelledby="stage-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="stage-heading" className="text-base font-semibold">
          Application stage
        </h2>
        {nextStage && !target && (
          <button
            type="button"
            className="btn btn-primary !px-3 !py-1.5 text-[13px]"
            onClick={() => setTarget(nextStage.key)}
          >
            Advance to {nextStage.label}
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error mb-3" role="alert">
          {error}
        </div>
      )}

      {target ? (
        <div className="mb-4 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-raised)] p-4">
          <p className="text-sm font-semibold">Move to {getStage(target).label}</p>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            The client will see: “{getStage(target).clientDescription}”
          </p>

          <label className="label mt-3" htmlFor="stage-note">
            Note for the client <span className="font-normal">(optional)</span>
          </label>
          <textarea
            id="stage-note"
            className="input min-h-[64px]"
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. The lender has asked for one more item — it is on your list now."
          />

          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={notify}
              onChange={(event) => setNotify(event.target.checked)}
            />
            Email the client about this change
          </label>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => void advance(target)}
            >
              {pending ? 'Updating…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pending}
              onClick={() => {
                setTarget(null);
                setNote('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {STAGES.map((stage) => {
            const isCurrent = stage.key === currentStageKey;
            const canMove = allowed.includes(stage.key);

            return (
              <button
                key={stage.key}
                type="button"
                disabled={isCurrent || !canMove}
                onClick={() => setTarget(stage.key)}
                title={isCurrent ? 'Current stage' : canMove ? stage.brokerHint : 'Not reachable from here'}
                className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  isCurrent
                    ? 'bg-[var(--color-accent-700)] text-white'
                    : canMove
                      ? 'border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[var(--color-ink-700)] hover:bg-[var(--color-raised)]'
                      : 'border border-[var(--color-line)] bg-[var(--color-canvas)] text-[var(--color-ink-300)]'
                }`}
              >
                {stage.label}
              </button>
            );
          })}
        </div>
      )}

      {history.length > 0 && (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]">
            Stage history ({history.length})
          </summary>
          <ul className="mt-2 space-y-1.5 border-l border-[var(--color-line)] pl-3">
            {history.map((entry, index) => (
              <li key={`${entry.stageKey}-${entry.createdAt}-${index}`}>
                <span className="font-medium">{getStage(entry.stageKey).label}</span>{' '}
                <span className="text-[var(--color-ink-400)]">
                  {new Date(entry.createdAt).toLocaleString('en-CA', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
                {entry.note && (
                  <p className="text-[var(--color-ink-500)]">“{entry.note}”</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
