'use client';

/**
 * Agent activity and manual skill invocation.
 *
 * Shows what the agent has done on this file and lets the broker run a skill
 * on demand. Skills are loaded from the registry, so anything you register
 * appears here without touching this component.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Run {
  id: string;
  skillKey: string;
  status: string;
  trigger: string;
  error: string | null;
  output: unknown;
  createdAt: string;
  durationMs: number | null;
}

interface SkillSummary {
  key: string;
  title: string;
  description: string;
  triggers: string[];
}

const STATUS_CLASS: Record<string, string> = {
  queued: 'badge-requested',
  running: 'badge-in_review',
  succeeded: 'badge-approved',
  failed: 'badge-needs_attention',
};

export function AgentPanel({ clientId, runs }: { clientId: string; runs: Run[] }) {
  const router = useRouter();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/broker/agent/run')
      .then((response) => (response.ok ? response.json() : { skills: [] }))
      .then((data: { skills?: SkillSummary[] }) => setSkills(data.skills ?? []))
      .catch(() => setSkills([]));
  }, []);

  async function run(skillKey: string) {
    setRunning(skillKey);
    setError(null);

    try {
      const response = await fetch('/api/broker/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillKey, clientId, input: { clientId } }),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) setError(data.error ?? 'The skill failed.');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRunning(null);
    }
  }

  // Only manual-trigger skills get a button. Automatic ones fire on their own
  // events, and offering a button for them invites double-running.
  const manualSkills = skills.filter((skill) => skill.triggers.includes('manual'));

  return (
    <section className="card p-5" aria-labelledby="agent-heading">
      <h2 id="agent-heading" className="text-base font-semibold">
        Agent
      </h2>
      <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
        Processing skills that have run on this file.
      </p>

      {error && (
        <div className="alert alert-error mt-3" role="alert">
          {error}
        </div>
      )}

      {manualSkills.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {manualSkills.map((skill) => (
            <button
              key={skill.key}
              type="button"
              title={skill.description}
              className="btn btn-secondary !px-3 !py-1.5 text-[13px]"
              disabled={running !== null}
              onClick={() => void run(skill.key)}
            >
              {running === skill.key ? 'Running…' : skill.title}
            </button>
          ))}
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {runs.length === 0 && (
          <li className="text-[13px] text-[var(--color-ink-400)]">No runs yet.</li>
        )}

        {runs.map((item) => (
          <li key={item.id} className="rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${STATUS_CLASS[item.status] ?? 'badge-requested'}`}>
                {item.status}
              </span>
              <span className="font-mono text-[12px]">{item.skillKey}</span>
              <span className="text-[12px] text-[var(--color-ink-400)]">
                {item.trigger} ·{' '}
                {new Date(item.createdAt).toLocaleString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
              </span>
            </div>

            {item.error && (
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-danger-600)]">
                {item.error}
              </p>
            )}

            {item.output != null && (
              <>
                <button
                  type="button"
                  className="mt-1.5 text-[12px] text-[var(--color-ink-500)] underline underline-offset-2"
                  onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                >
                  {expanded === item.id ? 'Hide output' : 'Show output'}
                </button>
                {expanded === item.id && (
                  <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-[var(--color-surface)] p-2 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(item.output, null, 2)}
                  </pre>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
