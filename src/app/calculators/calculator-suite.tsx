'use client';

/**
 * Public calculators.
 *
 * Every number here comes from `@/lib/finance`, the same modules the broker's
 * ratio panel uses. There is deliberately no second implementation: a borrower
 * who is quoted one payment on the marketing page and a different one on their
 * file has been misled, even if only by a rounding difference.
 *
 * They run entirely in the browser. No answer is posted anywhere, which is
 * worth saying out loud on the page — people are cautious about typing their
 * income into a mortgage website, and rightly so.
 */

import { useMemo, useState } from 'react';

import {
  amortizationSchedule,
  calculateInsurance,
  calculatePayment,
  minimumDownPayment,
  qualifyingRate,
  type PaymentFrequency,
} from '@/lib/finance/mortgage';
import { calculateLandTransferTax, type Province } from '@/lib/finance/land-transfer-tax';
import { calculateRatios, GDS_LIMIT, TDS_LIMIT } from '@/lib/finance/ratios';
import { PROVINCES, type Locale, type Localised } from '@/lib/intake/form';

type Tab = 'payment' | 'affordability' | 'closing';

const COPY = {
  title: { en: 'Mortgage calculators', fr: 'Calculatrices hypothécaires' },
  intro: {
    en: 'Canadian figures — semi-annual compounding, the stress test, and real provincial land transfer tax. Nothing you type here is sent anywhere.',
    fr: 'Chiffres canadiens — intérêt composé semestriellement, simulation de crise et droits de mutation provinciaux réels. Rien de ce que vous saisissez n’est transmis.',
  },
  tabPayment: { en: 'Payment', fr: 'Paiement' },
  tabAfford: { en: 'What can I afford?', fr: 'Quel montant puis-je obtenir?' },
  tabClosing: { en: 'Closing costs', fr: 'Frais de clôture' },

  price: { en: 'Purchase price', fr: 'Prix d’achat' },
  down: { en: 'Down payment', fr: 'Mise de fonds' },
  rate: { en: 'Interest rate (%)', fr: 'Taux d’intérêt (%)' },
  amortization: { en: 'Amortization (years)', fr: 'Amortissement (années)' },
  frequency: { en: 'Payment frequency', fr: 'Fréquence des paiements' },

  income: { en: 'Household income before tax', fr: 'Revenu du ménage avant impôt' },
  debts: { en: 'Monthly debt payments', fr: 'Paiements de dettes mensuels' },
  propertyTax: { en: 'Annual property tax', fr: 'Taxes foncières annuelles' },
  heat: { en: 'Monthly heating', fr: 'Chauffage mensuel' },
  condo: { en: 'Monthly condo fees', fr: 'Frais de copropriété mensuels' },

  province: { en: 'Province', fr: 'Province' },
  city: { en: 'City', fr: 'Ville' },
  firstTime: { en: 'First-time buyer', fr: 'Premier acheteur' },

  yourPayment: { en: 'Your payment', fr: 'Votre paiement' },
  perPayment: { en: 'per payment', fr: 'par versement' },
  monthlyEquivalent: { en: 'Monthly equivalent', fr: 'Équivalent mensuel' },
  mortgageAmount: { en: 'Mortgage amount', fr: 'Montant du prêt' },
  totalInterest: { en: 'Total interest over the amortization', fr: 'Intérêts totaux sur l’amortissement' },
  totalPaid: { en: 'Total paid', fr: 'Total payé' },
  payments: { en: 'Number of payments', fr: 'Nombre de versements' },
  insurance: { en: 'Default insurance premium', fr: 'Prime d’assurance prêt' },
  minimumDown: { en: 'Minimum down payment', fr: 'Mise de fonds minimale' },

  balanceAfter: { en: 'What you still owe', fr: 'Solde restant' },
  year: { en: 'Year', fr: 'Année' },
  principal: { en: 'Principal paid', fr: 'Capital remboursé' },
  interest: { en: 'Interest paid', fr: 'Intérêts payés' },
  balance: { en: 'Balance', fr: 'Solde' },

  maxMortgage: { en: 'You could qualify for about', fr: 'Vous pourriez être admissible à environ' },
  atStress: { en: 'Qualified at the stress-test rate of', fr: 'Admissibilité calculée au taux de simulation de' },
  ratiosNow: { en: 'At that amount', fr: 'À ce montant' },

  totalCash: { en: 'Cash you need on closing', fr: 'Liquidités requises à la clôture' },
  ltt: { en: 'Land transfer tax', fr: 'Droits de mutation' },
  rebate: { en: 'First-time buyer rebate', fr: 'Remboursement pour premier acheteur' },
  legal: { en: 'Legal fees (estimate)', fr: 'Frais juridiques (estimation)' },
  titleIns: { en: 'Title insurance (estimate)', fr: 'Assurance titres (estimation)' },
  inspection: { en: 'Home inspection (estimate)', fr: 'Inspection (estimation)' },
  appraisal: { en: 'Appraisal (estimate)', fr: 'Évaluation (estimation)' },

  disclaimer: {
    en: 'Estimates only. Your actual approval depends on credit, property and lender policy — start an application and we’ll confirm it properly.',
    fr: 'Estimations seulement. Votre approbation réelle dépend du crédit, de la propriété et des politiques du prêteur — commencez une demande et nous confirmerons le tout.',
  },
  startApplication: { en: 'Start an application', fr: 'Commencer une demande' },
  overLimit: { en: 'over the usual limit', fr: 'au-delà de la limite habituelle' },
  withinLimit: { en: 'within the usual limit', fr: 'sous la limite habituelle' },
} satisfies Record<string, Localised>;

const FREQUENCIES: Array<{ value: PaymentFrequency; label: Localised }> = [
  { value: 'monthly', label: { en: 'Monthly', fr: 'Mensuel' } },
  { value: 'semi_monthly', label: { en: 'Semi-monthly', fr: 'Bimensuel' } },
  { value: 'biweekly', label: { en: 'Every two weeks', fr: 'Aux deux semaines' } },
  {
    value: 'accelerated_biweekly',
    label: { en: 'Accelerated bi-weekly', fr: 'Aux deux semaines accéléré' },
  },
  { value: 'weekly', label: { en: 'Weekly', fr: 'Hebdomadaire' } },
  { value: 'accelerated_weekly', label: { en: 'Accelerated weekly', fr: 'Hebdomadaire accéléré' } },
];

const cash = (value: number, locale: Locale) =>
  value.toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  });

const exact = (value: number, locale: Locale) =>
  value.toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Reads a numeric input without turning an empty box into NaN. */
const parse = (value: string): number => {
  const cleaned = value.replace(/[^0-9.]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function CalculatorSuite({ initialLocale }: { initialLocale: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [tab, setTab] = useState<Tab>('payment');
  const t = (value: Localised) => value[locale];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex justify-end">
        <div
          role="group"
          aria-label={locale === 'fr' ? 'Langue' : 'Language'}
          className="inline-flex rounded-[var(--radius-control)] border border-[var(--color-line-strong)] bg-[var(--color-surface)] p-0.5"
        >
          {(['en', 'fr'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setLocale(option)}
              aria-pressed={locale === option}
              aria-label={option === 'en' ? 'English' : 'Français'}
              className={
                locale === option
                  ? 'rounded-[6px] bg-[var(--color-accent-700)] px-3 py-1 text-[13px] font-semibold text-white'
                  : 'rounded-[6px] px-3 py-1 text-[13px] font-semibold text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]'
              }
            >
              {option === 'en' ? 'EN' : 'FR'}
            </button>
          ))}
        </div>
      </div>

      <h1 className="text-2xl font-semibold tracking-[-0.01em] sm:text-[28px]">{t(COPY.title)}</h1>
      <p className="mt-2 max-w-xl text-[var(--color-ink-500)]">{t(COPY.intro)}</p>

      <div className="mt-6 mb-5 flex gap-1 overflow-x-auto" role="tablist">
        {(
          [
            ['payment', COPY.tabPayment],
            ['affordability', COPY.tabAfford],
            ['closing', COPY.tabClosing],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={
              'shrink-0 rounded-[var(--radius-control)] px-3.5 py-2 text-[13px] font-semibold transition-colors ' +
              (tab === key
                ? 'bg-[var(--color-accent-700)] text-white'
                : 'text-[var(--color-ink-500)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink-900)]')
            }
          >
            {t(label)}
          </button>
        ))}
      </div>

      {tab === 'payment' && <PaymentCalculator locale={locale} />}
      {tab === 'affordability' && <AffordabilityCalculator locale={locale} />}
      {tab === 'closing' && <ClosingCostCalculator locale={locale} />}

      <div className="card mt-6 flex flex-wrap items-center justify-between gap-4 p-5">
        <p className="max-w-md text-[13px] text-[var(--color-ink-500)]">{t(COPY.disclaimer)}</p>
        <a href={`/apply${locale === 'fr' ? '?lang=fr' : ''}`} className="btn btn-primary">
          {t(COPY.startApplication)}
        </a>
      </div>
    </div>
  );
}

function PaymentCalculator({ locale }: { locale: Locale }) {
  const t = (value: Localised) => value[locale];

  const [price, setPrice] = useState('750000');
  const [down, setDown] = useState('150000');
  const [rate, setRate] = useState('4.79');
  const [years, setYears] = useState('25');
  const [frequency, setFrequency] = useState<PaymentFrequency>('monthly');

  const result = useMemo(() => {
    const purchasePrice = parse(price);
    const downPayment = parse(down);
    const insurance = calculateInsurance(purchasePrice, downPayment);

    // The premium is added to the principal, not paid in cash — getting this
    // backwards understates the payment on every insured file.
    const principal = insurance.required && insurance.qualifies
      ? insurance.totalMortgage
      : Math.max(purchasePrice - downPayment, 0);

    const payment = calculatePayment({
      principal,
      annualRatePercent: parse(rate),
      amortizationYears: Math.max(parse(years), 1),
      frequency,
    });

    const schedule = amortizationSchedule({
      principal,
      annualRatePercent: parse(rate),
      amortizationYears: Math.max(parse(years), 1),
      frequency,
    });

    return {
      insurance,
      principal,
      payment,
      schedule: schedule.slice(0, 5),
      minimum: minimumDownPayment(purchasePrice),
    };
  }, [price, down, rate, years, frequency]);

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Money label={t(COPY.price)} value={price} onChange={setPrice} id="calc-price" />
          <Money label={t(COPY.down)} value={down} onChange={setDown} id="calc-down" />
          <Plain label={t(COPY.rate)} value={rate} onChange={setRate} id="calc-rate" suffix="%" />
          <Plain label={t(COPY.amortization)} value={years} onChange={setYears} id="calc-years" />
          <div className="sm:col-span-2">
            <label className="label" htmlFor="calc-frequency">
              {t(COPY.frequency)}
            </label>
            <select
              id="calc-frequency"
              className="input"
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as PaymentFrequency)}
            >
              {FREQUENCIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {parse(down) < result.minimum && parse(price) > 0 && (
          <div className="alert alert-warn mt-4">
            {t(COPY.minimumDown)}: {cash(result.minimum, locale)}
          </div>
        )}
      </div>

      <div className="card p-5">
        <p className="text-[13px] font-semibold tracking-wide text-[var(--color-ink-400)] uppercase">
          {t(COPY.yourPayment)}
        </p>
        <p className="mt-1 text-[34px] leading-tight font-semibold tabular-nums">
          {exact(result.payment.payment, locale)}
        </p>
        <p className="text-[13px] text-[var(--color-ink-500)]">
          {t(COPY.perPayment)} · {cash(result.payment.monthlyEquivalent, locale)}{' '}
          {t(COPY.monthlyEquivalent).toLowerCase()}
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-[var(--color-line)] pt-4 text-[13px]">
          <Row label={t(COPY.mortgageAmount)} value={cash(result.principal, locale)} />
          {result.insurance.required && result.insurance.qualifies && (
            <Row
              label={`${t(COPY.insurance)} (${result.insurance.premiumRate}%)`}
              value={cash(result.insurance.premium, locale)}
            />
          )}
          <Row label={t(COPY.payments)} value={String(result.payment.numberOfPayments)} />
          <Row label={t(COPY.totalInterest)} value={cash(result.payment.totalInterest, locale)} />
          <Row label={t(COPY.totalPaid)} value={cash(result.payment.totalPaid, locale)} strong />
        </dl>

        {!result.insurance.qualifies && (
          <div className="alert alert-error mt-4">
            {locale === 'fr'
              ? 'Une mise de fonds inférieure à 5 % n’est pas assurable au Canada.'
              : 'A down payment under 5% cannot be insured in Canada.'}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold">{t(COPY.balanceAfter)}</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[400px] text-[13px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-500)]">
                <th className="py-2 font-medium">{t(COPY.year)}</th>
                <th className="py-2 text-right font-medium">{t(COPY.principal)}</th>
                <th className="py-2 text-right font-medium">{t(COPY.interest)}</th>
                <th className="py-2 text-right font-medium">{t(COPY.balance)}</th>
              </tr>
            </thead>
            <tbody>
              {result.schedule.map((row) => (
                <tr key={row.year} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="py-2">{row.year}</td>
                  <td className="py-2 text-right tabular-nums">
                    {cash(row.principalPaid, locale)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-[var(--color-ink-500)]">
                    {cash(row.interestPaid, locale)}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {cash(row.endingBalance, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="field-hint">
          {locale === 'fr'
            ? 'Les premières années sont dominées par les intérêts. C’est normal — et c’est pourquoi les versements accélérés changent autant la donne.'
            : 'The early years are mostly interest. That is normal — and it is why accelerated payments make such a difference.'}
        </p>
      </div>
    </div>
  );
}

function AffordabilityCalculator({ locale }: { locale: Locale }) {
  const t = (value: Localised) => value[locale];

  const [income, setIncome] = useState('140000');
  const [debts, setDebts] = useState('600');
  const [rate, setRate] = useState('4.79');
  const [years, setYears] = useState('25');
  const [propertyTax, setPropertyTax] = useState('4800');
  const [heat, setHeat] = useState('120');
  const [condo, setCondo] = useState('0');

  const result = useMemo(() => {
    const base = {
      annualRatePercent: parse(rate),
      amortizationYears: Math.max(parse(years), 1),
      annualPropertyTax: parse(propertyTax),
      monthlyHeat: parse(heat),
      monthlyCondoFees: parse(condo),
      incomes: [{ annualIncome: parse(income), employmentType: 'salaried' }],
      liabilities: [{ monthlyPayment: parse(debts) }],
    };

    // Probe with a nominal amount to learn the ceiling, then re-run at that
    // ceiling so the ratios shown are the ratios at the number quoted.
    const probe = calculateRatios({ ...base, mortgageAmount: 1, propertyValue: 1 });
    const max = probe.maxMortgageByRatios;

    return {
      max,
      atMax: calculateRatios({
        ...base,
        mortgageAmount: max,
        // Assume 20% down, so the quoted mortgage is not silently insured.
        propertyValue: max > 0 ? max / 0.8 : 1,
      }),
      qualifyingRatePercent: qualifyingRate(parse(rate)),
    };
  }, [income, debts, rate, years, propertyTax, heat, condo]);

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Money label={t(COPY.income)} value={income} onChange={setIncome} id="aff-income" />
          <Money label={t(COPY.debts)} value={debts} onChange={setDebts} id="aff-debts" />
          <Plain label={t(COPY.rate)} value={rate} onChange={setRate} id="aff-rate" suffix="%" />
          <Plain label={t(COPY.amortization)} value={years} onChange={setYears} id="aff-years" />
          <Money label={t(COPY.propertyTax)} value={propertyTax} onChange={setPropertyTax} id="aff-tax" />
          <Money label={t(COPY.heat)} value={heat} onChange={setHeat} id="aff-heat" />
          <Money label={t(COPY.condo)} value={condo} onChange={setCondo} id="aff-condo" />
        </div>
      </div>

      <div className="card p-5">
        <p className="text-[13px] font-semibold tracking-wide text-[var(--color-ink-400)] uppercase">
          {t(COPY.maxMortgage)}
        </p>
        <p className="mt-1 text-[34px] leading-tight font-semibold tabular-nums">
          {cash(result.max, locale)}
        </p>
        <p className="text-[13px] text-[var(--color-ink-500)]">
          {t(COPY.atStress)} {result.qualifyingRatePercent}%
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-[var(--color-line)] pt-4 text-[13px]">
          <Row
            label="GDS"
            value={`${result.atMax.gds}% / ${GDS_LIMIT}% ${
              result.atMax.gdsPasses ? t(COPY.withinLimit) : t(COPY.overLimit)
            }`}
          />
          <Row
            label="TDS"
            value={`${result.atMax.tds}% / ${TDS_LIMIT}% ${
              result.atMax.tdsPasses ? t(COPY.withinLimit) : t(COPY.overLimit)
            }`}
          />
          <Row
            label={t(COPY.yourPayment)}
            value={cash(result.atMax.monthlyMortgagePayment, locale)}
          />
        </dl>

        <p className="field-hint mt-4">
          {locale === 'fr'
            ? 'Le montant est calculé au taux de simulation de crise, pas à votre taux réel — c’est ainsi que le prêteur décide.'
            : 'This is calculated at the stress-test rate, not your actual rate — that is how the lender decides.'}
        </p>
      </div>
    </div>
  );
}

function ClosingCostCalculator({ locale }: { locale: Locale }) {
  const t = (value: Localised) => value[locale];

  const [price, setPrice] = useState('750000');
  const [province, setProvince] = useState<Province>('ON');
  const [city, setCity] = useState('Toronto');
  const [firstTime, setFirstTime] = useState(false);

  const legalFees = 1_800;
  const titleInsurance = 400;
  const inspection = 500;
  const appraisal = 400;

  const ltt = useMemo(
    () =>
      calculateLandTransferTax({
        purchasePrice: parse(price),
        province,
        city,
        isFirstTimeBuyer: firstTime,
      }),
    [price, province, city, firstTime],
  );

  const total = ltt.totalTax + legalFees + titleInsurance + inspection + appraisal;
  const rebate = ltt.provincialRebate + ltt.municipalRebate;

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Money label={t(COPY.price)} value={price} onChange={setPrice} id="cc-price" />
          <div>
            <label className="label" htmlFor="cc-province">
              {t(COPY.province)}
            </label>
            <select
              id="cc-province"
              className="input"
              value={province}
              onChange={(event) => setProvince(event.target.value as Province)}
            >
              {PROVINCES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label[locale]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="cc-city">
              {t(COPY.city)}
            </label>
            <input
              id="cc-city"
              className="input"
              value={city}
              onChange={(event) => setCity(event.target.value)}
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 self-end pb-2 text-[15px]">
            <input
              type="checkbox"
              checked={firstTime}
              onChange={(event) => setFirstTime(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent-700)]"
            />
            {t(COPY.firstTime)}
          </label>
        </div>
      </div>

      <div className="card p-5">
        <p className="text-[13px] font-semibold tracking-wide text-[var(--color-ink-400)] uppercase">
          {t(COPY.totalCash)}
        </p>
        <p className="mt-1 text-[34px] leading-tight font-semibold tabular-nums">
          {cash(total, locale)}
        </p>
        <p className="text-[13px] text-[var(--color-ink-500)]">
          {locale === 'fr' ? 'En plus de votre mise de fonds.' : 'On top of your down payment.'}
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-[var(--color-line)] pt-4 text-[13px]">
          <Row
            label={t(COPY.ltt)}
            value={cash(ltt.provincialTax + ltt.municipalTax, locale)}
          />
          {rebate > 0 && <Row label={t(COPY.rebate)} value={`− ${cash(rebate, locale)}`} />}
          <Row label={t(COPY.legal)} value={cash(legalFees, locale)} />
          <Row label={t(COPY.titleIns)} value={cash(titleInsurance, locale)} />
          <Row label={t(COPY.inspection)} value={cash(inspection, locale)} />
          <Row label={t(COPY.appraisal)} value={cash(appraisal, locale)} />
        </dl>

        <p className={ltt.supported ? 'field-hint mt-4' : 'alert alert-warn mt-4'}>{ltt.note}</p>
      </div>
    </div>
  );
}

function Money({
  label,
  value,
  onChange,
  id,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  id: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--color-ink-400)]">
          $
        </span>
        <input
          id={id}
          className="input pl-7 tabular-nums"
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

function Plain({
  label,
  value,
  onChange,
  id,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  id: string;
  suffix?: string;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          className={'input tabular-nums' + (suffix ? ' pr-8' : '')}
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix && (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[var(--color-ink-400)]">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className="text-[var(--color-ink-500)]">{label}</dt>
      <dd className={'text-right tabular-nums ' + (strong ? 'font-semibold' : 'font-medium')}>
        {value}
      </dd>
    </>
  );
}
