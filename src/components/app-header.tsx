'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function AppHeader({
  appName,
  userName,
  subtitle,
  nav,
}: {
  appName: string;
  userName: string;
  subtitle?: string;
  nav?: React.ReactNode;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-700)] text-sm font-bold text-white">
            U
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{appName}</p>
            {subtitle && (
              <p className="truncate text-xs text-[var(--color-ink-400)]">{subtitle}</p>
            )}
          </div>
        </div>

        {nav && <nav className="order-3 w-full sm:order-none sm:w-auto">{nav}</nav>}

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-sm text-[var(--color-ink-500)] sm:inline">{userName}</span>
          <button
            type="button"
            onClick={signOut}
            className="btn btn-secondary !px-3 !py-1.5 text-[13px]"
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </header>
  );
}
