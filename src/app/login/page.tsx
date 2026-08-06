import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect(user.kind === 'broker' ? '/broker' : '/dashboard');
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-[10px] bg-[var(--color-accent-700)] text-base font-bold tracking-tight text-white">
            U
          </div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-[var(--color-ink-900)]">
            {env.appName}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-500)]">
            Sign in to your mortgage application.
          </p>
        </div>

        <div className="card p-6">
          <LoginForm />
        </div>

        <p className="mt-6 text-center text-[13px] leading-relaxed text-[var(--color-ink-400)]">
          Trouble signing in? Reply to the email that contained your login details and
          your broker will help.
        </p>
      </div>
    </main>
  );
}
