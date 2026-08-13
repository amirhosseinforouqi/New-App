'use client';

/**
 * Service worker registration, and the install prompt.
 *
 * Two deliberate restraints:
 *
 *   The prompt is only shown after the browser fires `beforeinstallprompt`,
 *   which it does when the app genuinely qualifies. Nothing is invented — no
 *   fake banner on iOS, where the API does not exist.
 *
 *   It is dismissible and the dismissal sticks. An install nag that returns
 *   every visit is how people learn to ignore the whole interface.
 */

import { useEffect, useState } from 'react';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'uwa-install-dismissed';

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      // Registered after load so it never competes with the first paint.
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // A failed registration is not worth surfacing: the portal works
        // perfectly well without it, it simply is not installable.
      });
    }

    if (localStorage.getItem(DISMISSED_KEY)) return;

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as InstallEvent);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!deferred) return null;

  return (
    <div className="card mb-6 flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="text-[13px]">
        <strong>Add this to your home screen</strong> to check your application without signing in
        through a browser each time.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary px-3 py-1.5 text-[13px]"
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, '1');
            setDeferred(null);
          }}
        >
          Not now
        </button>
        <button
          type="button"
          className="btn btn-primary px-3 py-1.5 text-[13px]"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            localStorage.setItem(DISMISSED_KEY, '1');
            setDeferred(null);
          }}
        >
          Install
        </button>
      </div>
    </div>
  );
}
