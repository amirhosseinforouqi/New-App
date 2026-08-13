import Link from 'next/link';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';

import { asBroker, asSystem } from '@/db';
import { brokers, webhooks } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { getCurrentUser } from '@/lib/auth/session';
import { listApiKeys } from '@/lib/api/keys';
import { WEBHOOK_EVENTS } from '@/lib/api/webhooks';
import { env } from '@/lib/env';
import { IntegrationsPanel } from './integrations-panel';

export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const [role] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  const isOwner = role?.role === 'owner';

  const { keys, hooks } = await asBroker(user.id, async (db) => ({
    keys: isOwner ? await listApiKeys(db) : [],
    hooks: isOwner
      ? await db
          .select({
            id: webhooks.id,
            url: webhooks.url,
            events: webhooks.events,
            createdAt: webhooks.createdAt,
          })
          .from(webhooks)
          .orderBy(desc(webhooks.createdAt))
      : [],
  }));

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Broker workspace"
        nav={<BrokerNav />}
      />

      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/broker/deals"
          className="text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← Back
        </Link>

        <h1 className="mt-3 mb-1 text-[22px] font-semibold tracking-[-0.01em]">Integrations</h1>
        <p className="mb-6 text-sm text-[var(--color-ink-500)]">
          Connect the portal to Zapier, a CRM, or your own website.
        </p>

        {!isOwner ? (
          <div className="card p-5">
            <div className="alert alert-warn">
              Only the brokerage owner can manage API keys and webhooks. A key can read every
              file in the brokerage, so it is not something an individual agent account issues.
            </div>
          </div>
        ) : (
          <>
            <IntegrationsPanel
              keys={keys.map((key) => ({
                ...key,
                lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
                revokedAt: key.revokedAt?.toISOString() ?? null,
                createdAt: key.createdAt.toISOString(),
              }))}
              hooks={hooks.map((hook) => ({
                ...hook,
                createdAt: hook.createdAt.toISOString(),
              }))}
              events={WEBHOOK_EVENTS}
            />

            <section className="card mt-5 p-5">
              <h2 className="text-sm font-semibold">Using the API</h2>
              <p className="mt-1 text-[13px] text-[var(--color-ink-500)]">
                Full reference in <code className="font-mono text-[12px]">docs/API.md</code>.
              </p>

              <pre className="mt-3 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-3.5 font-mono text-[12px] leading-relaxed">
{`# List deals
curl ${env.appUrl}/api/v1/deals \\
  -H "Authorization: Bearer uwa_live_..."

# Create a lead from your website
curl -X POST ${env.appUrl}/api/v1/leads \\
  -H "Authorization: Bearer uwa_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"full_name":"Jordan Fisher","email":"jordan@example.ca",
       "deal_type":"purchase","purchase_price":750000}'`}
              </pre>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
