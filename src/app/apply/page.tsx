import type { Metadata } from 'next';

import { ApplyForm } from './apply-form';
import type { Locale } from '@/lib/intake/form';

export const metadata: Metadata = {
  title: 'Start your mortgage application',
  description:
    'Tell us what you need and we’ll open your file, tell you exactly which documents to gather, and give you a secure portal to track it.',
};

export const dynamic = 'force-dynamic';

/**
 * The only page in the portal that does not require a login.
 *
 * `?lang=fr` opens it in French and `?ref=CODE` attributes the lead — both are
 * read here rather than in the client component so a referral link shared by a
 * realtor works on first paint, with no flash of the wrong language.
 */
export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const rawLang = Array.isArray(params.lang) ? params.lang[0] : params.lang;
  const locale: Locale = rawLang === 'fr' ? 'fr' : 'en';

  const rawRef = Array.isArray(params.ref) ? params.ref[0] : params.ref;
  const referralCode = rawRef?.slice(0, 64) || undefined;

  return (
    <main className="min-h-dvh px-4 py-10 sm:px-6 sm:py-16">
      <ApplyForm initialLocale={locale} referralCode={referralCode} />
    </main>
  );
}
