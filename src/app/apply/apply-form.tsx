'use client';

/**
 * The intake renderer.
 *
 * It knows nothing about mortgages. Every question, its label in both
 * languages, when it appears and which tiers it belongs to comes from
 * `@/lib/intake/form`. That separation is what makes the form editable by
 * someone who is not a React developer.
 *
 * Visibility is recomputed from the current answers on every render rather
 * than cached, so answering "condo" makes the condo-fee question appear
 * immediately, and changing it back to "detached" removes both the question
 * and — on submit — the answer.
 */

import { useMemo, useState } from 'react';

import {
  TIER_META,
  missingRequired,
  visibleFields,
  visibleSteps,
  type Answers,
  type Field,
  type Locale,
  type Localised,
  type Tier,
} from '@/lib/intake/form';

const COPY = {
  eyebrow: { en: 'Mortgage application', fr: 'Demande hypothécaire' },
  headline: {
    en: 'Let’s find out where you stand.',
    fr: 'Voyons où vous en êtes.',
  },
  subhead: {
    en: 'Choose how much detail you want to give us now. You can always add the rest later — nothing is lost.',
    fr: 'Choisissez le niveau de détail que vous souhaitez fournir maintenant. Vous pourrez compléter plus tard — rien n’est perdu.',
  },
  minutes: { en: 'min', fr: 'min' },
  back: { en: 'Back', fr: 'Retour' },
  next: { en: 'Continue', fr: 'Continuer' },
  submit: { en: 'Submit my application', fr: 'Envoyer ma demande' },
  submitting: { en: 'Submitting…', fr: 'Envoi en cours…' },
  stepOf: { en: 'Step', fr: 'Étape' },
  of: { en: 'of', fr: 'de' },
  optional: { en: 'optional', fr: 'facultatif' },
  required: { en: 'Please answer the highlighted questions.', fr: 'Veuillez répondre aux questions en surbrillance.' },
  failed: {
    en: 'Something went wrong. Please try again.',
    fr: 'Une erreur est survenue. Veuillez réessayer.',
  },
  changeTier: { en: 'Change form', fr: 'Changer de formulaire' },
  choose: { en: 'Choose one', fr: 'Faites un choix' },
  doneTitle: { en: 'Your application is in.', fr: 'Votre demande est envoyée.' },
  doneBody: {
    en: 'We’ve emailed you a secure login for your portal. Sign in to upload documents, message your broker and watch your file move.',
    fr: 'Nous vous avons envoyé par courriel un accès sécurisé à votre portail. Connectez-vous pour téléverser vos documents, écrire à votre courtier et suivre votre dossier.',
  },
  // Shown instead when the credentials email did not go out. Telling someone to
  // check an inbox that will never receive anything is worse than saying so.
  doneBodyNoEmail: {
    en: 'Your broker has your file and will be in touch shortly with your portal login. Quote your reference below if you need to call.',
    fr: 'Votre courtier a votre dossier et vous transmettra sous peu votre accès au portail. Mentionnez la référence ci-dessous si vous appelez.',
  },
  doneReference: { en: 'Your file reference', fr: 'Référence de votre dossier' },
  doneCoBorrower: {
    en: 'Your co-borrower gets their own separate login — you never share yours.',
    fr: 'Votre coemprunteur obtient son propre accès distinct — vous ne partagez jamais le vôtre.',
  },
  goToPortal: { en: 'Go to the portal', fr: 'Accéder au portail' },
  privacy: {
    en: 'Your information is stored in Canada and is never shared without your consent.',
    fr: 'Vos renseignements sont conservés au Canada et ne sont jamais partagés sans votre consentement.',
  },
  justLooking: {
    en: 'Not ready yet? Try the calculators',
    fr: 'Pas encore prêt? Essayez les calculatrices',
  },
} satisfies Record<string, Localised>;

interface Props {
  referralCode?: string;
  initialLocale: Locale;
}

export function ApplyForm({ referralCode, initialLocale }: Props) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [tier, setTier] = useState<Tier | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    reference: string;
    coBorrowerInvited: boolean;
    emailSent: boolean;
  } | null>(null);

  const t = (value: Localised) => value[locale];

  const steps = useMemo(() => (tier ? visibleSteps(tier, answers) : []), [tier, answers]);
  const step = steps[Math.min(stepIndex, Math.max(steps.length - 1, 0))];
  const isLastStep = stepIndex >= steps.length - 1;

  const missing = useMemo(
    () => (step && tier ? missingRequired(step, tier, answers) : []),
    [step, tier, answers],
  );

  function setAnswer(id: string, value: Answers[string]) {
    setAnswers((previous) => ({ ...previous, [id]: value }));
  }

  function goNext() {
    if (missing.length > 0) {
      setTouched(true);
      return;
    }
    setTouched(false);
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  async function submit() {
    if (!tier) return;
    if (missing.length > 0) {
      setTouched(true);
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, locale, answers, referralCode }),
      });

      const data = (await response.json()) as {
        reference?: string;
        coBorrowerInvited?: boolean;
        emailSent?: boolean;
        error?: string;
      };

      if (!response.ok) {
        setError(data.error ?? t(COPY.failed));
        return;
      }

      setDone({
        reference: data.reference ?? '',
        coBorrowerInvited: data.coBorrowerInvited ?? false,
        emailSent: data.emailSent ?? false,
      });
    } catch {
      setError(t(COPY.failed));
    } finally {
      setPending(false);
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="card mx-auto max-w-lg p-6 sm:p-8">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-ok-100)] text-[var(--color-ok-600)]">
          ✓
        </div>
        <h1 className="text-xl font-semibold">{t(COPY.doneTitle)}</h1>
        <p className="mt-2 text-[var(--color-ink-500)]">
          {t(done.emailSent ? COPY.doneBody : COPY.doneBodyNoEmail)}
        </p>

        {done.reference && (
          <div className="mt-5 rounded-[var(--radius-control)] bg-[var(--color-canvas)] px-4 py-3">
            <div className="text-[13px] text-[var(--color-ink-500)]">{t(COPY.doneReference)}</div>
            <div className="font-mono text-base font-semibold">{done.reference}</div>
          </div>
        )}

        {done.coBorrowerInvited && (
          <div className="alert alert-ok mt-4">{t(COPY.doneCoBorrower)}</div>
        )}

        <a href="/login" className="btn btn-primary mt-6 w-full">
          {t(COPY.goToPortal)}
        </a>
      </div>
    );
  }

  // ── Tier chooser ───────────────────────────────────────────────────────────
  if (!tier) {
    return (
      <div className="mx-auto max-w-2xl">
        <LocaleToggle locale={locale} onChange={setLocale} />

        <p className="text-[13px] font-semibold tracking-wide text-[var(--color-accent-600)] uppercase">
          {t(COPY.eyebrow)}
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">{t(COPY.headline)}</h1>
        <p className="mt-3 max-w-lg text-[var(--color-ink-500)]">{t(COPY.subhead)}</p>

        <div className="mt-8 grid gap-3">
          {(Object.keys(TIER_META) as Tier[]).map((key) => {
            const meta = TIER_META[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setTier(key);
                  setStepIndex(0);
                }}
                className="card group flex items-center gap-4 p-5 text-left transition-colors hover:border-[var(--color-accent-500)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{t(meta.label)}</div>
                  <div className="mt-1 text-[13px] text-[var(--color-ink-500)]">
                    {t(meta.blurb)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold text-[var(--color-accent-700)]">
                    {meta.minutes} {t(COPY.minutes)}
                  </div>
                </div>
                <span
                  aria-hidden
                  className="shrink-0 text-[var(--color-ink-300)] transition-colors group-hover:text-[var(--color-accent-500)]"
                >
                  →
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-6">
          <a
            href={`/calculators${locale === 'fr' ? '?lang=fr' : ''}`}
            className="text-[13px] font-semibold text-[var(--color-accent-600)] hover:underline"
          >
            {t(COPY.justLooking)} →
          </a>
        </p>

        <p className="field-hint mt-4">{t(COPY.privacy)}</p>
      </div>
    );
  }

  if (!step) return null;

  // ── The form ───────────────────────────────────────────────────────────────
  const progress = ((stepIndex + 1) / steps.length) * 100;

  return (
    <div className="mx-auto max-w-2xl">
      <LocaleToggle locale={locale} onChange={setLocale} />

      <div className="mb-5">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-[var(--color-ink-500)]">
            {t(COPY.stepOf)} {stepIndex + 1} {t(COPY.of)} {steps.length}
          </span>
          <button
            type="button"
            className="text-[13px] text-[var(--color-ink-400)] underline underline-offset-2 hover:text-[var(--color-ink-700)]"
            onClick={() => {
              setTier(null);
              setStepIndex(0);
              setTouched(false);
            }}
          >
            {t(COPY.changeTier)}
          </button>
        </div>
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={steps.length}
        >
          <div
            className="h-full rounded-full bg-[var(--color-accent-700)] transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <form
        method="post"
        className="card p-5 sm:p-7"
        onSubmit={(event) => {
          event.preventDefault();
          if (isLastStep) void submit();
          else goNext();
        }}
      >
        <h1 className="text-lg font-semibold sm:text-xl">{t(step.title)}</h1>
        {step.description && (
          <p className="mt-1.5 text-[var(--color-ink-500)]">{t(step.description)}</p>
        )}

        <div className="mt-6 space-y-5">
          {visibleFields(step, tier, answers).map((field) => (
            <FieldControl
              key={field.id}
              field={field}
              locale={locale}
              value={answers[field.id]}
              invalid={touched && missing.some((item) => item.id === field.id)}
              onChange={(value) => setAnswer(field.id, value)}
            />
          ))}
        </div>

        {touched && missing.length > 0 && (
          <div className="alert alert-error mt-5" role="alert">
            {t(COPY.required)}
          </div>
        )}

        {error && (
          <div className="alert alert-error mt-5" role="alert">
            {error}
          </div>
        )}

        <div className="mt-7 flex items-center gap-3">
          {stepIndex > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setTouched(false);
                setStepIndex((index) => Math.max(index - 1, 0));
              }}
            >
              {t(COPY.back)}
            </button>
          )}
          <button type="submit" className="btn btn-primary flex-1" disabled={pending}>
            {pending ? t(COPY.submitting) : isLastStep ? t(COPY.submit) : t(COPY.next)}
          </button>
        </div>
      </form>

      <p className="field-hint mt-5 text-center">{t(COPY.privacy)}</p>
    </div>
  );
}

function LocaleToggle({
  locale,
  onChange,
}: {
  locale: Locale;
  onChange: (next: Locale) => void;
}) {
  return (
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
            onClick={() => onChange(option)}
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
  );
}

function FieldControl({
  field,
  locale,
  value,
  invalid,
  onChange,
}: {
  field: Field;
  locale: Locale;
  value: Answers[string];
  invalid: boolean;
  onChange: (value: Answers[string]) => void;
}) {
  const label = field.label[locale];
  const help = field.help?.[locale];
  const placeholder = field.placeholder?.[locale];
  const describedBy = help ? `${field.id}-help` : undefined;
  const border = invalid ? { borderColor: 'var(--color-danger-600)' } : undefined;
  const asString = value === undefined || value === null ? '' : String(value);

  // Checkbox carries its own label to the right of the box.
  if (field.type === 'checkbox') {
    return (
      <div>
        <label className="flex cursor-pointer items-start gap-3 text-[15px] leading-relaxed">
          <input
            id={field.id}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent-700)]"
            aria-invalid={invalid || undefined}
          />
          <span className={invalid ? 'text-[var(--color-danger-600)]' : undefined}>{label}</span>
        </label>
      </div>
    );
  }

  if (field.type === 'radio') {
    return (
      <fieldset>
        <legend className="label">
          {label}
          {!field.required && <OptionalTag locale={locale} />}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(field.options ?? []).map((option) => {
            const selected = asString === option.value;
            return (
              <label
                key={option.value}
                className={
                  'flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border px-3.5 py-2.5 text-[15px] transition-colors ' +
                  (selected
                    ? 'border-[var(--color-accent-700)] bg-[var(--color-accent-100)]'
                    : 'border-[var(--color-line-strong)] hover:bg-[var(--color-raised)]')
                }
                style={invalid && !selected ? border : undefined}
              >
                <input
                  type="radio"
                  name={field.id}
                  value={option.value}
                  checked={selected}
                  onChange={() => onChange(option.value)}
                  className="h-4 w-4 accent-[var(--color-accent-700)]"
                />
                <span>{option.label[locale]}</span>
              </label>
            );
          })}
        </div>
        {help && (
          <p id={describedBy} className="field-hint">
            {help}
          </p>
        )}
      </fieldset>
    );
  }

  return (
    <div>
      <label className="label" htmlFor={field.id}>
        {label}
        {!field.required && <OptionalTag locale={locale} />}
      </label>

      {field.type === 'select' ? (
        <select
          id={field.id}
          className="input"
          value={asString}
          onChange={(event) => onChange(event.target.value)}
          style={border}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        >
          <option value="">{COPY.choose[locale]}…</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label[locale]}
            </option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          id={field.id}
          className="input min-h-[96px]"
          value={asString}
          placeholder={placeholder}
          maxLength={2000}
          onChange={(event) => onChange(event.target.value)}
          style={border}
          aria-describedby={describedBy}
        />
      ) : field.type === 'currency' ? (
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--color-ink-400)]">
            $
          </span>
          <input
            id={field.id}
            className="input pl-7"
            inputMode="decimal"
            value={asString}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            style={border}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
          />
        </div>
      ) : (
        <input
          id={field.id}
          className="input"
          type={field.type === 'number' ? 'number' : field.type}
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          min={field.min}
          max={field.max}
          value={asString}
          placeholder={placeholder}
          autoComplete={AUTOCOMPLETE[field.id]}
          onChange={(event) => onChange(event.target.value)}
          style={border}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
      )}

      {help && (
        <p id={describedBy} className="field-hint">
          {help}
        </p>
      )}
    </div>
  );
}

function OptionalTag({ locale }: { locale: Locale }) {
  return (
    <span className="ml-1.5 font-normal text-[var(--color-ink-400)]">
      ({COPY.optional[locale]})
    </span>
  );
}

/** Let the browser fill the boring parts. Nobody enjoys typing their own email. */
const AUTOCOMPLETE: Record<string, string | undefined> = {
  fullName: 'name',
  email: 'email',
  phone: 'tel',
  propertyAddress: 'street-address',
  propertyCity: 'address-level2',
};
