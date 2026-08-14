import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { asBroker, asSystem } from '@/db';
import { brokers } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { getCurrentUser } from '@/lib/auth/session';
import { loadRuleOverrides } from '@/lib/deals/rule-settings';
import { RULES } from '@/lib/deals/validation';
import { env } from '@/lib/env';
import { RulePanel } from './rule-panel';

export const dynamic = 'force-dynamic';

export default async function RulesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const [me] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  const overrides = await asBroker(user.id, (db) => loadRuleOverrides(db));

  // Everyone can read the rules — knowing what the bar is makes it easier to
  // clear. Only an owner can move it, which the panel enforces and the API
  // enforces again.
  const rules = RULES.map((rule) => {
    const override = rule.locked ? undefined : overrides.get(rule.key);
    const severity = override?.severity ?? rule.defaultSeverity;
    const enabled = override?.enabled ?? true;

    return {
      key: rule.key,
      label: rule.label,
      defaultSeverity: rule.defaultSeverity,
      severity,
      enabled,
      locked: rule.locked ?? false,
      lockedReason: rule.lockedReason ?? null,
      customised: severity !== rule.defaultSeverity || !enabled,
    };
  });

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Broker workspace"
        nav={<BrokerNav />}
      />

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/broker/deals"
          className="text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← Back
        </Link>

        <h1 className="mt-3 mb-1 text-[22px] font-semibold tracking-[-0.01em]">Submission rules</h1>
        <p className="mb-6 text-sm text-[var(--color-ink-500)]">
          What has to be true before a file can be sent to a lender.
        </p>

        <RulePanel rules={rules} canEdit={me?.role === 'owner'} />
      </main>
    </div>
  );
}
