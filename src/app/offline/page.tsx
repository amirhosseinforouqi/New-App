import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'No connection' };

/**
 * Shown by the service worker when a page navigation fails.
 *
 * Static and self-contained — it has to render from cache with no network and
 * no server. It deliberately shows nothing about the borrower's file, because
 * the whole reason nothing else is cached is that stale financial data must
 * not outlive a sign-out.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="card max-w-sm p-6 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-canvas)] text-[var(--color-ink-400)]">
          ⚡
        </div>
        <h1 className="text-lg font-semibold">You are offline</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-500)]">
          Your application is safe — it just needs a connection to load. Nothing about your file
          is stored on this device, which is why there is nothing to show you here.
        </p>
        <p className="mt-4 text-[13px] text-[var(--color-ink-400)]">
          Try again once you are back online.
        </p>
      </div>
    </main>
  );
}
