/**
 * Document status pill.
 *
 * Wording differs by audience deliberately. The broker's "For your review" is
 * an instruction to them; the client seeing that phrase would think *they*
 * have to do something. Same underlying state, different label.
 */

const CLIENT_LABELS: Record<string, string> = {
  requested: 'Needed',
  in_review: 'Received',
  needs_attention: 'Action needed',
  approved: 'Accepted',
};

const BROKER_LABELS: Record<string, string> = {
  requested: 'Requested',
  in_review: 'For your review',
  needs_attention: 'Needs attention',
  approved: 'Approved',
};

export function StatusBadge({
  status,
  audience = 'client',
}: {
  status: string;
  audience?: 'client' | 'broker';
}) {
  const labels = audience === 'broker' ? BROKER_LABELS : CLIENT_LABELS;
  const label = labels[status] ?? status;

  return (
    <span className={`badge badge-${status}`}>
      {status === 'needs_attention' && (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
          <path d="M6 1 11 10.5H1L6 1Zm0 3.2v3.1m0 1.6v.1" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
      )}
      {status === 'approved' && (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.3 4.8 8.6 9.5 3.9" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {label}
    </span>
  );
}
