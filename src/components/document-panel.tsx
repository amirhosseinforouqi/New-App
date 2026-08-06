'use client';

/**
 * Client-facing document area.
 *
 * Structure borrowed from Finmo's borrower portal, which gets one thing very
 * right: the client sees a checklist of what is *needed*, not a file manager.
 * The upload target is the checklist item, so "what do I still owe you" is
 * answerable at a glance.
 *
 * Mobile capture is first-class (`capture` on the file input) because, per
 * Velocity's borrower flow, photographing a document with a phone is how most
 * uploads actually happen — asking a client to scan and email a PDF is where
 * files stall for a week.
 */

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { StatusBadge } from './status-badge';

export interface ChecklistItem {
  id: string;
  label: string;
  description: string | null;
  category: string;
  isRequired: boolean;
  status: string;
  reviewNote: string | null;
}

export interface UploadedDocument {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  reviewNote: string | null;
  requestId: string | null;
  createdAt: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx,.xls,.xlsx';

function UploadButton({
  requestId,
  label,
  onUploaded,
  variant = 'secondary',
}: {
  requestId: string | null;
  label: string;
  onUploaded: () => void;
  variant?: 'primary' | 'secondary';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setUploading(true);
    setError(null);

    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        if (requestId) form.append('requestId', requestId);

        const response = await fetch('/api/documents/upload', { method: 'POST', body: form });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Upload of ${file.name} failed.`);
        }
      }
      onUploaded();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept={ACCEPT}
        multiple
        onChange={(event) => void handleFiles(event.target.files)}
      />
      <button
        type="button"
        className={`btn ${variant === 'primary' ? 'btn-primary' : 'btn-secondary'} !px-3 !py-1.5 text-[13px]`}
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? 'Uploading…' : label}
      </button>
      {error && <p className="field-hint text-[var(--color-danger-600)]">{error}</p>}
    </div>
  );
}

export function DocumentPanel({
  checklist,
  documents,
}: {
  checklist: ChecklistItem[];
  documents: UploadedDocument[];
}) {
  const router = useRouter();
  const refresh = () => router.refresh();

  const outstanding = checklist.filter(
    (item) => item.status === 'requested' || item.status === 'needs_attention',
  );
  const done = checklist.filter((item) => item.status === 'in_review' || item.status === 'approved');
  const unlinked = documents.filter((doc) => doc.requestId === null);

  const docsFor = (requestId: string) => documents.filter((doc) => doc.requestId === requestId);

  return (
    <section className="card" aria-labelledby="documents-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-4">
        <div>
          <h2 id="documents-heading" className="text-base font-semibold">
            Documents
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            {outstanding.length === 0
              ? 'Everything requested has been received.'
              : `${outstanding.length} item${outstanding.length === 1 ? '' : 's'} still needed.`}
          </p>
        </div>
        <UploadButton
          requestId={null}
          label="Upload a file"
          variant="primary"
          onUploaded={refresh}
        />
      </div>

      <div className="divide-y divide-[var(--color-line)]">
        {checklist.length === 0 && (
          <p className="px-5 py-8 text-center text-sm text-[var(--color-ink-400)]">
            Your document list is being prepared. You will get an email when it is ready — or
            upload anything you already have using the button above.
          </p>
        )}

        {[...outstanding, ...done].map((item) => {
          const attached = docsFor(item.id);

          return (
            <div key={item.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{item.label}</h3>
                    <StatusBadge status={item.status} />
                    {!item.isRequired && (
                      <span className="text-xs text-[var(--color-ink-400)]">if applicable</span>
                    )}
                  </div>

                  {item.description && (
                    <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                      {item.description}
                    </p>
                  )}

                  {item.reviewNote && item.status === 'needs_attention' && (
                    <p className="mt-2 rounded-[var(--radius-control)] bg-[var(--color-warn-100)] px-3 py-2 text-[13px] leading-relaxed text-[var(--color-warn-600)]">
                      {item.reviewNote}
                    </p>
                  )}

                  {attached.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {attached.map((doc) => (
                        <li key={doc.id} className="flex items-center gap-2 text-[13px]">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            className="shrink-0 text-[var(--color-ink-300)]"
                            aria-hidden="true"
                          >
                            <path
                              d="M8 1.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 12.5h6a1.5 1.5 0 0 0 1.5-1.5V5L8 1.5Z"
                              stroke="currentColor"
                              strokeWidth="1.1"
                              fill="none"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <a
                            href={`/api/documents/${doc.id}/download`}
                            className="truncate text-[var(--color-accent-600)] underline underline-offset-2 hover:text-[var(--color-accent-700)]"
                          >
                            {doc.fileName}
                          </a>
                          <span className="shrink-0 text-[var(--color-ink-400)]">
                            {formatSize(doc.sizeBytes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <UploadButton
                  requestId={item.id}
                  label={attached.length > 0 ? 'Replace' : 'Upload'}
                  onUploaded={refresh}
                />
              </div>
            </div>
          );
        })}

        {unlinked.length > 0 && (
          <div className="px-5 py-4">
            <h3 className="text-sm font-semibold">Other files you sent</h3>
            <ul className="mt-2 space-y-1.5">
              {unlinked.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <a
                    href={`/api/documents/${doc.id}/download`}
                    className="truncate text-[var(--color-accent-600)] underline underline-offset-2"
                  >
                    {doc.fileName}
                  </a>
                  <span className="text-[var(--color-ink-400)]">{formatSize(doc.sizeBytes)}</span>
                  <StatusBadge status={doc.status} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="border-t border-[var(--color-line)] px-5 py-3 text-xs leading-relaxed text-[var(--color-ink-400)]">
        Your files are stored privately and are visible only to you and your broker. Photos taken
        on your phone are fine — just make sure all four edges of the page are in the frame.
      </p>
    </section>
  );
}
