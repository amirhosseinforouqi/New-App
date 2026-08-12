'use client';

/**
 * The deals board.
 *
 * Card view in columns, one per pipeline stage. Two ways to move a deal,
 * deliberately:
 *
 *   Drag a card between columns — fast on a desktop, which is where a broker
 *   works a pipeline.
 *
 *   Open the card's menu and pick a stage — works on a phone, with a keyboard,
 *   and with a screen reader. HTML5 drag and drop does none of those, so a
 *   drag-only board would be an accessibility dead end rather than a
 *   convenience.
 *
 * The server still enforces the one-stage-at-a-time rule. A drag that breaks it
 * is refused and the card snaps back with the reason shown — the board never
 * decides on its own what a valid move is.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { STAGES } from '@/lib/pipeline/stages';

export interface BoardDeal {
  id: string;
  reference: string;
  dealType: string;
  stageKey: string;
  status: string;
  assignedTo: string | null;
  locked: boolean;
  mortgageAmount: number | null;
  propertyCity: string | null;
  propertyProvince: string | null;
  leadSource: string | null;
  borrowerNames: string[];
  awaitingReview: number;
  outstanding: number;
  unread: number;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  fullName: string;
}

const DEAL_TYPE_LABELS: Record<string, string> = {
  purchase: 'Purchase',
  refinance: 'Refinance',
  renewal: 'Renewal',
  heloc: 'HELOC',
  preapproval: 'Pre-approval',
  construction: 'Construction',
  commercial: 'Commercial',
};

const money = (value: number | null) =>
  value === null
    ? null
    : value.toLocaleString('en-CA', {
        style: 'currency',
        currency: 'CAD',
        maximumFractionDigits: 0,
      });

export function DealBoard({ deals, team }: { deals: BoardDeal[]; team: TeamMember[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverStage, setHoverStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function patch(dealId: string, body: Record<string, unknown>) {
    setPendingId(dealId);
    setError(null);

    try {
      const response = await fetch(`/api/broker/deals/${dealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? 'That change could not be saved.');
        return;
      }

      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPendingId(null);
    }
  }

  const byStage = new Map<string, BoardDeal[]>();
  for (const stage of STAGES) byStage.set(stage.key, []);
  for (const deal of deals) {
    byStage.get(deal.stageKey)?.push(deal);
  }

  return (
    <div>
      {error && (
        <div className="alert alert-error mb-4" role="alert">
          {error}
        </div>
      )}

      {/* Horizontal scroller: six stages will never fit a phone, and squeezing
          them would make every card unreadable. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-3">
          {STAGES.map((stage) => {
            const column = byStage.get(stage.key) ?? [];
            const isTarget = hoverStage === stage.key && dragId !== null;

            return (
              <section
                key={stage.key}
                className={
                  'w-[280px] shrink-0 rounded-[var(--radius-card)] border p-2.5 transition-colors ' +
                  (isTarget
                    ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-100)]'
                    : 'border-[var(--color-line)] bg-[var(--color-raised)]')
                }
                onDragOver={(event) => {
                  if (!dragId) return;
                  event.preventDefault();
                  setHoverStage(stage.key);
                }}
                onDragLeave={() => setHoverStage((current) => (current === stage.key ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  const id = dragId;
                  setDragId(null);
                  setHoverStage(null);
                  if (!id) return;

                  const deal = deals.find((item) => item.id === id);
                  if (!deal || deal.stageKey === stage.key) return;
                  void patch(id, { action: 'move', stageKey: stage.key });
                }}
              >
                <header className="mb-2.5 flex items-baseline justify-between gap-2 px-1">
                  <h2
                    className="text-[11px] font-semibold tracking-wide text-[var(--color-ink-500)] uppercase"
                    title={stage.brokerHint}
                  >
                    {stage.label}
                  </h2>
                  <span className="text-[13px] font-semibold tabular-nums text-[var(--color-ink-400)]">
                    {column.length}
                  </span>
                </header>

                <div className="space-y-2">
                  {column.map((deal) => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      team={team}
                      pending={pendingId === deal.id}
                      dragging={dragId === deal.id}
                      onDragStart={() => setDragId(deal.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setHoverStage(null);
                      }}
                      onAction={(body) => void patch(deal.id, body)}
                    />
                  ))}

                  {column.length === 0 && (
                    <p className="px-1 py-6 text-center text-[13px] text-[var(--color-ink-300)]">
                      Nothing here
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  team,
  pending,
  dragging,
  onDragStart,
  onDragEnd,
  onAction,
}: {
  deal: BoardDeal;
  team: TeamMember[];
  pending: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onAction: (body: Record<string, unknown>) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const amount = money(deal.mortgageAmount);
  const place = [deal.propertyCity, deal.propertyProvince].filter(Boolean).join(', ');
  const assignee = team.find((member) => member.id === deal.assignedTo);

  return (
    <article
      draggable={!pending}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={
        'card relative p-3 transition-opacity ' +
        (dragging ? 'opacity-40' : '') +
        (pending ? ' opacity-60' : '')
      }
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/broker/deals/${deal.id}`}
          className="min-w-0 flex-1 hover:underline"
          draggable={false}
        >
          <p className="truncate text-sm font-semibold">
            {deal.borrowerNames[0] ?? 'Unnamed borrower'}
          </p>
        </Link>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-label={`Actions for ${deal.reference}`}
          className="-mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[var(--color-ink-400)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink-700)]"
        >
          ⋯
        </button>
      </div>

      {deal.borrowerNames.length > 1 && (
        <p className="mt-0.5 truncate text-[12px] text-[var(--color-ink-400)]">
          with {deal.borrowerNames.slice(1).join(', ')}
        </p>
      )}

      <p className="mt-1.5 font-mono text-[11px] text-[var(--color-ink-400)]">{deal.reference}</p>

      <p className="mt-1 text-[13px] text-[var(--color-ink-500)]">
        {DEAL_TYPE_LABELS[deal.dealType] ?? deal.dealType}
        {amount && <> · {amount}</>}
      </p>
      {place && <p className="text-[13px] text-[var(--color-ink-400)]">{place}</p>}

      {(deal.unread > 0 || deal.awaitingReview > 0 || deal.outstanding > 0 || deal.locked) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {deal.locked && <span className="badge badge-needs_attention">Locked</span>}
          {deal.unread > 0 && <span className="badge badge-in_review">{deal.unread} unread</span>}
          {deal.awaitingReview > 0 && (
            <span className="badge badge-in_review">{deal.awaitingReview} to review</span>
          )}
          {deal.outstanding > 0 && (
            <span className="badge badge-requested">{deal.outstanding} outstanding</span>
          )}
        </div>
      )}

      {assignee && (
        <p className="mt-2 text-[12px] text-[var(--color-ink-400)]">Assigned to {assignee.fullName}</p>
      )}

      {menuOpen && (
        <div className="mt-3 space-y-2.5 border-t border-[var(--color-line)] pt-3">
          <div>
            <label className="label" htmlFor={`move-${deal.id}`}>
              Move to stage
            </label>
            <select
              id={`move-${deal.id}`}
              className="input text-[13px]"
              value={deal.stageKey}
              disabled={pending}
              onChange={(event) => {
                if (event.target.value === deal.stageKey) return;
                onAction({ action: 'move', stageKey: event.target.value });
                setMenuOpen(false);
              }}
            >
              {STAGES.map((stage) => (
                <option key={stage.key} value={stage.key}>
                  {stage.label}
                </option>
              ))}
            </select>
          </div>

          {team.length > 0 && (
            <div>
              <label className="label" htmlFor={`assign-${deal.id}`}>
                Assigned to
              </label>
              <select
                id={`assign-${deal.id}`}
                className="input text-[13px]"
                value={deal.assignedTo ?? ''}
                disabled={pending}
                onChange={(event) => {
                  onAction({ action: 'assign', assignedTo: event.target.value || null });
                  setMenuOpen(false);
                }}
              >
                <option value="">Unassigned</option>
                {team.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-secondary flex-1 px-2 py-1.5 text-[13px]"
              disabled={pending}
              onClick={() => {
                onAction({ action: 'lock', locked: !deal.locked });
                setMenuOpen(false);
              }}
            >
              {deal.locked ? 'Unlock' : 'Lock'}
            </button>
            <button
              type="button"
              className="btn btn-danger flex-1 px-2 py-1.5 text-[13px]"
              disabled={pending}
              onClick={() => {
                onAction({ action: 'archive', archived: true });
                setMenuOpen(false);
              }}
            >
              Archive
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
