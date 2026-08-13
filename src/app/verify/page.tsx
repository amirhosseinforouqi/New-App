import { redirect } from 'next/navigation';

import { getCurrentUser, getPendingMfaUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { VerifyForm } from './verify-form';

export const dynamic = 'force-dynamic';

export default async function VerifyPage() {
  const pending = await getPendingMfaUser();

  if (!pending) {
    // Either signed out entirely, or already verified. Send them where they
    // belong rather than showing a challenge that has nothing to challenge.
    const user = await getCurrentUser();
    if (!user) redirect('/login');
    redirect(user.kind === 'broker' ? '/broker' : '/dashboard');
  }

  const label = pending.kind === 'client' ? pending.username : pending.email;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-700)] text-sm font-bold text-white">
            U
          </span>
          <div>
            <p className="text-sm leading-tight font-semibold">{env.appName}</p>
            <p className="text-xs text-[var(--color-ink-400)]">Two-factor verification</p>
          </div>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold">One more step</h1>
          <p className="mt-1 mb-5 text-[13px] text-[var(--color-ink-500)]">
            Your password was accepted. Enter the code from your authenticator to finish signing
            in.
          </p>

          <VerifyForm accountLabel={label} />
        </div>

        <form action="/api/auth/logout" method="post" className="mt-4 text-center">
          <button
            type="submit"
            className="text-[13px] text-[var(--color-ink-400)] hover:text-[var(--color-ink-700)]"
          >
            Cancel and sign out
          </button>
        </form>
      </div>
    </main>
  );
}
