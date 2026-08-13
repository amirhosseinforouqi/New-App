'use client';

import { useState } from 'react';

interface PreviewResult {
  willImport: number;
  errors: Array<{ line: number; field: string; value: string; message: string }>;
  unmappedColumns: string[];
  sample: Array<Record<string, unknown>>;
}

interface CommitResult {
  imported: number;
  failed: Array<{ email: string; error: string }>;
  skipped: number;
}

export function ImportPanel() {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [done, setDone] = useState<CommitResult | null>(null);

  async function send(commit: boolean) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/broker/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, commit }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not work.');
        return;
      }

      if (commit) setDone(data as CommitResult);
      else setPreview(data as PreviewResult);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="card p-5">
        <h2 className="text-sm font-semibold">Import finished</h2>
        <div className="alert alert-ok mt-3">
          {done.imported} deal{done.imported === 1 ? '' : 's'} imported.
        </div>

        {done.skipped > 0 && (
          <div className="alert alert-warn mt-3">
            {done.skipped} row{done.skipped === 1 ? '' : 's'} were skipped because of errors in the
            file. Fix them and import those separately.
          </div>
        )}

        {done.failed.length > 0 && (
          <div className="alert alert-error mt-3">
            {done.failed.length} failed while writing:{' '}
            {done.failed.slice(0, 3).map((failure) => failure.email).join(', ')}
            {done.failed.length > 3 && '…'}
          </div>
        )}

        <p className="field-hint mt-3">
          No credentials were emailed. Reissue them per client from their page when you are ready
          — a migration that mails hundreds of people a password unannounced is a bad afternoon.
        </p>

        <button
          type="button"
          className="btn btn-secondary mt-4"
          onClick={() => {
            setDone(null);
            setPreview(null);
            setCsv('');
            setFileName('');
          }}
        >
          Import another file
        </button>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold">Import deals from a CSV</h2>
      <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
        Export from your current system and drop the file here. Column names are matched
        loosely — &ldquo;Client Name&rdquo;, &ldquo;Borrower&rdquo; and &ldquo;Name&rdquo; all
        work.
      </p>

      {error && (
        <div className="alert alert-error mt-3" role="alert">
          {error}
        </div>
      )}

      <div className="mt-4">
        <label className="label" htmlFor="csv-file">
          CSV file
        </label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          className="input"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setFileName(file.name);
            setCsv(await file.text());
            setPreview(null);
          }}
        />
        {fileName && <p className="field-hint">{fileName}</p>}
      </div>

      {csv && !preview && (
        <button
          type="button"
          className="btn btn-primary mt-4"
          disabled={pending}
          onClick={() => void send(false)}
        >
          {pending ? 'Checking…' : 'Check the file'}
        </button>
      )}

      {preview && (
        <div className="mt-5 border-t border-[var(--color-line)] pt-4">
          <p className="text-[13px]">
            <strong>{preview.willImport}</strong> row{preview.willImport === 1 ? '' : 's'} ready to
            import
            {preview.errors.length > 0 && (
              <>
                , <strong>{preview.errors.length}</strong> will be skipped
              </>
            )}
            .
          </p>

          {preview.unmappedColumns.length > 0 && (
            <div className="alert alert-warn mt-3">
              These columns were not recognised and will be ignored:{' '}
              {preview.unmappedColumns.join(', ')}.
            </div>
          )}

          {preview.errors.length > 0 && (
            <div className="mt-3 max-h-56 overflow-y-auto rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-3">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[var(--color-ink-500)]">
                    <th className="pb-1 font-medium">Line</th>
                    <th className="pb-1 font-medium">Field</th>
                    <th className="pb-1 font-medium">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.errors.map((issue) => (
                    <tr key={`${issue.line}-${issue.field}`}>
                      <td className="py-0.5 tabular-nums">{issue.line}</td>
                      <td className="py-0.5">{issue.field}</td>
                      <td className="py-0.5 text-[var(--color-ink-500)]">{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="field-hint mt-3">
            Line numbers match your spreadsheet, so a row you need to fix is where it says.
          </p>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setPreview(null);
                setCsv('');
                setFileName('');
              }}
            >
              Start over
            </button>
            <button
              type="button"
              className="btn btn-primary flex-1"
              disabled={pending || preview.willImport === 0}
              onClick={() => void send(true)}
            >
              {pending ? 'Importing…' : `Import ${preview.willImport} deal${preview.willImport === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
