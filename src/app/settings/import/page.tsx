import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { asSystem } from '@/db';
import { brokers } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { getCurrentUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { ImportPanel } from './import-panel';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const [role] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Broker workspace"
        nav={<BrokerNav />}
      />

      <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/broker/deals"
          className="text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← Back
        </Link>

        <h1 className="mt-3 mb-1 text-[22px] font-semibold tracking-[-0.01em]">
          Import existing deals
        </h1>
        <p className="mb-6 text-sm text-[var(--color-ink-500)]">
          Bring your back catalogue across from another system.
        </p>

        {role?.role !== 'owner' ? (
          <div className="card p-5">
            <div className="alert alert-warn">
              Only the brokerage owner can import deals. It creates client accounts in bulk.
            </div>
          </div>
        ) : (
          <>
            <ImportPanel />

            <section className="card mt-5 p-5">
              <h2 className="text-sm font-semibold">About Filogix</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                This is a CSV importer, not a Filogix connector. Filogix Expert&rsquo;s API is
                licensed and needs a commercial agreement with Finastra — there is no way to write
                one without the contract, and a button that claimed to be one would be a lie.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                What every one of those systems will give you is an export, which is what you
                actually have in your hands on day one. If you sign a licensed connector later, it
                maps onto the same importer and nothing downstream changes.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
