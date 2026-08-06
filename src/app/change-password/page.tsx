import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/session';
import { ChangePasswordForm } from './change-password-form';

export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'client') redirect('/broker');

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[440px]">
        <div className="mb-8 text-center">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">
            {user.mustChangePassword ? 'Choose your password' : 'Change your password'}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-ink-500)]">
            {user.mustChangePassword
              ? 'Replace the temporary password from your email with one only you know.'
              : 'Pick something you have not used elsewhere.'}
          </p>
        </div>

        <div className="card p-6">
          <ChangePasswordForm />
        </div>
      </div>
    </main>
  );
}
