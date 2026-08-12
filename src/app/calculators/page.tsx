import type { Metadata } from 'next';

import type { Locale } from '@/lib/intake/form';
import { CalculatorSuite } from './calculator-suite';

export const metadata: Metadata = {
  title: 'Mortgage calculators',
  description:
    'Canadian mortgage payment, affordability and closing cost calculators — semi-annual compounding, the stress test, and real provincial land transfer tax.',
};

export default async function CalculatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawLang = Array.isArray(params.lang) ? params.lang[0] : params.lang;
  const locale: Locale = rawLang === 'fr' ? 'fr' : 'en';

  return (
    <main className="min-h-dvh px-4 py-10 sm:px-6 sm:py-16">
      <CalculatorSuite initialLocale={locale} />
    </main>
  );
}
