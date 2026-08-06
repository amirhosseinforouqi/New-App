import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getCurrentUser();

  if (!user) redirect('/login');
  if (user.kind === 'broker') redirect('/broker');
  redirect(user.mustChangePassword ? '/change-password' : '/dashboard');
}
