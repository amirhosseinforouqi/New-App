'use client';

/**
 * Document review queue.
 *
 * Grouped by Finmo's four states, which is the clearest model in the market
 * for this job: the broker's question is always "what is waiting on me", and
 * "For your review" answers it directly.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { StatusBadge } from '@/components/status-badge';

interface ChecklistItem {
  id: string;
  label: string;
  description: string | null;
  status: string;
  isRequired: boolean;
  createdBy: string;
}

interface DocumentItem {
  id: string;
  fileName: string;
  sizeBytes: number;
  status: string;
  reviewNote: string | null;
  requestId: string | null;
  classifiedAs: string | null;
  createdAt: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReviewRow({ doc, onDone }: { doc: DocumentItem; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState(doc.reviewNote ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review(status: 'approved' | 'needs_attention') {
    if (status === 'needs_attention' && !note.trim()) {
      setRejecting(true);
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/broker/documents/${doc.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          reviewNote: status === 'needs_attention' ? note.trim() : undefined,
          notifyClient: status === 'needs_attention',
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'Could not save the review.');
        setPending(false);
        return;
      }

      setRejecting(false);
      onDone();
    } catch {
      setError('Could not reach the server.');
      setPending(false);
    }
  }

  return (
    <div className="px-5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/documents/${doc.id}/download`}
              className="truncate text-sm font-medium text-[var(--color-accent-600)] underline underline-offset-2"
            >
              {doc.fileName}
            </a>
            <StatusBadge status={doc.status} audience="broker" />
          </div>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            {doc.classifiedAs ? (
              <>
                <span className="font-medium text-[var(--color-ink-700)]">{doc.classifiedAs}</span>{' '}
                ·{' '}
              </>
            ) : null}
            {formatSize(doc.sizeBytes)} ·{' '}
            {new Date(doc.createdAt).toLocaleDateString('en-CA', {
              month: 'short',
              day: 'numeric',
            })}
          </p>
          {doc.reviewNote && (
            <p className="mt-1 text-[13px] text-[var(--color-warn-600)]">{doc.reviewNote}</p>
          )}
        </div>

        {doc.status !== 'approved' && (
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-secondary !px-2.5 !py-1 text-[13px]"
              disabled={pending}
              onClick={() => void review('approved')}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn btn-danger !px-2.5 !py-1 text-[13px]"
              disabled={pending}
              onClick={() => setRejecting(true)}
            >
              Send back
            </button>
          </div>
        )}
      </div>

      {rejecting && (
        <div className="mt-3 rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-3">
          <label className="label" htmlFor={`note-${doc.id}`}>
            What does the client need to fix?
          </label>
          <input
            id={`note-${doc.id}`}
            className="input"
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. The bottom of the page is cut off — please re-photograph all four corners."
          />
          <p className="field-hint">This is emailed to the client and shown on their dashboard.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn btn-primary !px-3 !py-1.5 text-[13px]"
              disabled={pending || !note.trim()}
              onClick={() => void review('needs_attention')}
            >
              {pending ? 'Sending…' : 'Send back'}
            </button>
            <button
              type="button"
              className="btn btn-secondary !px-3 !py-1.5 text-[13px]"
              onClick={() => setRejecting(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error mt-2" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function DocumentReview({
  clientId,
  checklist,
  documents,
  outstandingCount,
}: {
  clientId: string;
  checklist: ChecklistItem[];
  documents: DocumentItem[];
  outstandingCount: number;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);

  const awaiting = documents.filter((doc) => doc.status === 'in_review');
  const flagged = documents.filter((doc) => doc.status === 'needs_attention');
  const approved = documents.filter((doc) => doc.status === 'approved');
  const outstanding = checklist.filter(
    (item) => item.status === 'requested' || item.status === 'needs_attention',
  );

  async function addRequest() {
    if (!label.trim()) return;
    setPending(true);

    try {
      await fetch('/api/broker/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          items: [{ label: label.trim(), description: description.trim() || undefined }],
          notifyClient: true,
        }),
      });
      setLabel('');
      setDescription('');
      setAdding(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card" aria-labelledby="docs-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-4">
        <div>
          <h2 id="docs-heading" className="text-base font-semibold">
            Documents
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            {awaiting.length} awaiting review · {outstandingCount} outstanding
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary !px-3 !py-1.5 text-[13px]"
          onClick={() => setAdding((value) => !value)}
        >
          Request a document
        </button>
      </div>

      {adding && (
        <div className="border-b border-[var(--color-line)] bg-[var(--color-raised)] px-5 py-4">
          <label className="label" htmlFor="new-request-label">
            What do you need?
          </label>
          <input
            id="new-request-label"
            className="input"
            value={label}
            maxLength={200}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. 2024 Notice of Assessment"
          />
          <label className="label mt-3" htmlFor="new-request-description">
            Instruction for the client
          </label>
          <input
            id="new-request-description"
            className="input"
            value={description}
            maxLength={1000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. All pages, as issued by the CRA."
          />
          <button
            type="button"
            className="btn btn-primary mt-3 !px-3 !py-1.5 text-[13px]"
            disabled={pending || !label.trim()}
            onClick={() => void addRequest()}
          >
            {pending ? 'Adding…' : 'Add and notify client'}
          </button>
        </div>
      )}

      {awaiting.length > 0 && (
        <div>
          <p className="bg-[var(--color-info-100)] px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-info-600)]">
            For your review
          </p>
          <div className="divide-y divide-[var(--color-line)]">
            {awaiting.map((doc) => (
              <ReviewRow key={doc.id} doc={doc} onDone={() => router.refresh()} />
            ))}
          </div>
        </div>
      )}

      {flagged.length > 0 && (
        <div>
          <p className="bg-[var(--color-warn-100)] px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-warn-600)]">
            Sent back to the client
          </p>
          <div className="divide-y divide-[var(--color-line)]">
            {flagged.map((doc) => (
              <ReviewRow key={doc.id} doc={doc} onDone={() => router.refresh()} />
            ))}
          </div>
        </div>
      )}

      {outstanding.length > 0 && (
        <div>
          <p className="bg-[var(--color-canvas)] px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-ink-400)]">
            Requested — nothing uploaded yet
          </p>
          <ul className="divide-y divide-[var(--color-line)]">
            {outstanding.map((item) => (
              <li key={item.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{item.label}</span>
                  {!item.isRequired && (
                    <span className="text-xs text-[var(--color-ink-400)]">if applicable</span>
                  )}
                  {item.createdBy === 'agent' && (
                    <span className="badge badge-requested">agent</span>
                  )}
                </div>
                {item.description && (
                  <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
                    {item.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {approved.length > 0 && (
        <details className="border-t border-[var(--color-line)]">
          <summary className="cursor-pointer px-5 py-2.5 text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]">
            Approved ({approved.length})
          </summary>
          <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
            {approved.map((doc) => (
              <li key={doc.id} className="flex items-center gap-2 px-5 py-2.5 text-[13px]">
                <a
                  href={`/api/documents/${doc.id}/download`}
                  className="truncate text-[var(--color-accent-600)] underline underline-offset-2"
                >
                  {doc.fileName}
                </a>
                <StatusBadge status="approved" audience="broker" />
              </li>
            ))}
          </ul>
        </details>
      )}

      {documents.length === 0 && checklist.length === 0 && (
        <p className="px-5 py-10 text-center text-sm text-[var(--color-ink-400)]">
          No documents or checklist items yet.
        </p>
      )}
    </section>
  );
}
