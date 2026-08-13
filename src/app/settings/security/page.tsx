import Link from 'next/link';
import { redirect } from 'next/navigation';

import { asSystem } from '@/db';
import { AppHeader } from '@/components/app-header';
import { getCurrentUser } from '@/lib/auth/session';
import { getMfaStatus } from '@/lib/auth/mfa';
import { env } from '@/lib/env';
import { SecurityPanel } from './security-panel';

export const dynamic = 'force-dynamic';

/** One page for both audiences — the settings are identical either way. */
export default async function SecuritySettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!user.mfaSatisfied) redirect('/verify');

  const status = await asSystem(async (db) => getMfaStatus(db, user.kind, user.id));
  const home = user.kind === 'broker' ? '/broker' : '/dashboard';

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle={user.kind === 'broker' ? 'Broker workspace' : 'Your application'}
      />

      <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href={home}
          className="text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← Back
        </Link>

        <h1 className="mt-3 mb-1 text-[22px] font-semibold tracking-[-0.01em]">Security</h1>
        <p className="mb-6 text-sm text-[var(--color-ink-500)]">
          Signed in as {user.kind === 'client' ? user.username : user.email}.
        </p>

        <SecurityPanel
          enabled={status.enabled}
          recoveryCodesRemaining={status.recoveryCodesRemaining}
        />

        <div className="card mt-5 p-5">
          <h2 className="text-sm font-semibold">Password</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            Changing your password signs you out of every other device.
          </p>
          <Link href="/change-password" className="btn btn-secondary mt-4">
            Change password
          </Link>
        </div>
      </main>
    </div>
  );
}
