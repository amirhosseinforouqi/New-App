/**
 * Application pathway timeline.
 *
 * Vertical on mobile, horizontal from `md` up. Two rules govern what it shows:
 *
 *  1. Future stages are visibly locked and carry no dates. Guessing at timing
 *     ("expected in 3 days") is how a portal turns a delay into a complaint.
 *  2. The current stage is the only one with the accent colour, so a client
 *     glancing at their phone can find their position without reading.
 *
 * Completed stages show the date they were reached, which comes from real
 * stage-history rows — not from anything inferred.
 */

import { stageStates, type StageState } from '@/lib/pipeline/stages';

export interface TimelineProps {
  currentStageKey: string;
  /** stage key → ISO date the client entered it. */
  reachedAt?: Record<string, string>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function Marker({ state, index }: { state: StageState; index: number }) {
  if (state === 'complete') {
    return (
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-ok-600)] text-white"
        aria-hidden="true"
      >
        <svg width="14" height="14" viewBox="0 0 14 14">
          <path
            d="M3 7.4 5.7 10 11 4.4"
            stroke="currentColor"
            strokeWidth="1.9"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (state === 'current') {
    return (
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-700)] text-[13px] font-semibold text-white ring-4 ring-[var(--color-accent-100)]"
        aria-hidden="true"
      >
        {index + 1}
      </span>
    );
  }

  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-ink-300)]"
      aria-hidden="true"
    >
      {index + 1}
    </span>
  );
}

export function StageTimeline({ currentStageKey, reachedAt = {} }: TimelineProps) {
  const stages = stageStates(currentStageKey);
  const current = stages.find((stage) => stage.state === 'current');

  return (
    <section className="card p-6" aria-labelledby="timeline-heading">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="timeline-heading" className="text-base font-semibold">
          Your application
        </h2>
        {current && (
          <p className="text-sm text-[var(--color-ink-500)]">
            Step {stages.indexOf(current) + 1} of {stages.length}
          </p>
        )}
      </div>

      {/* Screen-reader summary — the visual timeline is decorative repetition
          of this sentence, and a list of six items with icons is a poor
          listening experience. */}
      <p className="sr-only">
        Your application is currently at stage {current ? stages.indexOf(current) + 1 : 1} of{' '}
        {stages.length}: {current?.label}. {current?.clientDescription}
      </p>

      <ol className="flex flex-col gap-0 md:flex-row md:gap-2" aria-hidden="true">
        {stages.map((stage, index) => {
          const isLast = index === stages.length - 1;
          const date = reachedAt[stage.key];

          return (
            <li key={stage.key} className="relative flex flex-1 gap-3 pb-6 md:flex-col md:pb-0">
              {/* Connector: vertical on mobile, horizontal on desktop. */}
              {!isLast && (
                <>
                  <span
                    className={`absolute left-[13px] top-8 h-[calc(100%-2rem)] w-px md:hidden ${
                      stage.state === 'complete'
                        ? 'bg-[var(--color-ok-600)]'
                        : 'bg-[var(--color-line)]'
                    }`}
                  />
                  <span
                    className={`absolute left-[calc(50%+18px)] right-[calc(-50%+18px)] top-[13px] hidden h-px md:block ${
                      stage.state === 'complete'
                        ? 'bg-[var(--color-ok-600)]'
                        : 'bg-[var(--color-line)]'
                    }`}
                  />
                </>
              )}

              <div className="md:flex md:justify-center">
                <Marker state={stage.state} index={index} />
              </div>

              <div className="min-w-0 flex-1 md:mt-3 md:text-center">
                <p
                  className={`text-sm font-semibold leading-tight ${
                    stage.state === 'locked'
                      ? 'text-[var(--color-ink-300)]'
                      : stage.state === 'current'
                        ? 'text-[var(--color-accent-700)]'
                        : 'text-[var(--color-ink-700)]'
                  }`}
                >
                  {stage.label}
                </p>

                {date && stage.state !== 'locked' && (
                  <p className="mt-0.5 text-xs text-[var(--color-ink-400)]">{formatDate(date)}</p>
                )}

                {stage.state === 'current' && (
                  <p className="mt-1.5 text-[13px] leading-snug text-[var(--color-ink-500)] md:hidden">
                    {stage.clientDescription}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {current && (
        <div className="mt-6 rounded-[var(--radius-control)] bg-[var(--color-accent-100)] px-4 py-3">
          <p className="text-sm font-semibold text-[var(--color-accent-700)]">{current.label}</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-ink-700)]">
            {current.clientDescription}
          </p>
        </div>
      )}
    </section>
  );
}
