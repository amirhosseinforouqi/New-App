/**
 * Reading intake answers.
 *
 * Everything here is pure: answers in, values out. It is separate from
 * `submit.ts` purely so it can be tested without a database — `submit.ts`
 * imports the connection pool, which is a hard dependency at import time.
 *
 * The parsing is deliberately forgiving. A borrower filling this in on a phone
 * at 11pm types "875,000" or "$875 000" or "875000.00", and rejecting any of
 * those loses the lead. Being strict is the API route's job, on the fields that
 * matter; being generous is this module's.
 */

import {
  INTAKE_STEPS,
  missingRequired,
  visibleFields,
  type Answers,
  type Tier,
} from './form';

/** Money as typed by a human: "750,000", "$750 000", "750000.50". */
export function money(answers: Answers, key: string): number | null {
  const raw = answers[key];
  if (raw === undefined || raw === null || raw === '') return null;

  const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function text(answers: Answers, key: string): string | null {
  const raw = answers[key];
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

/** Postgres `numeric` columns take strings through Drizzle. */
export const numeric = (value: number | null): string | null =>
  value === null ? null : String(value);

/**
 * The mortgage being asked for.
 *
 * A purchase is price minus down payment. A refinance or HELOC is the existing
 * balance plus whatever they want to take out. Anything else — a pre-approval
 * with no property in mind yet — has no amount, and null is the honest answer
 * rather than a zero that looks like a real figure in the broker's pipeline.
 */
export function requestedMortgage(answers: Answers): number | null {
  const dealType = text(answers, 'dealType') ?? 'purchase';

  if (dealType === 'purchase' || dealType === 'preapproval') {
    const price = money(answers, 'purchasePrice');
    if (price === null) return null;
    return Math.max(price - (money(answers, 'downPayment') ?? 0), 0);
  }

  const balance = money(answers, 'existingBalance');
  if (balance === null) return null;
  return balance + (money(answers, 'additionalFundsNeeded') ?? 0);
}

/**
 * Required visible questions still unanswered, across every step of the tier.
 *
 * The browser runs the same check step by step; this one runs over the whole
 * form at submission. The browser's version is a convenience, this one is the
 * rule — a POST straight to the API skips the UI entirely.
 */
export function validateSubmission(tier: Tier, answers: Answers): string[] {
  const problems: string[] = [];

  for (const step of INTAKE_STEPS) {
    if (!step.tiers.includes(tier)) continue;
    for (const field of missingRequired(step, tier, answers)) {
      problems.push(field.id);
    }
  }

  return problems;
}

/**
 * Drop answers for questions that are not visible at this tier.
 *
 * Someone who selects "condo", fills in the fees, then switches to "detached"
 * would otherwise leave a stale condo-fee figure behind — which lands in the
 * GDS calculation and quietly understates what they qualify for. Anything the
 * borrower cannot currently see is not part of their answer.
 */
export function pruneToVisible(tier: Tier, answers: Answers): Answers {
  const kept: Answers = {};

  for (const step of INTAKE_STEPS) {
    if (!step.tiers.includes(tier)) continue;
    for (const field of visibleFields(step, tier, answers)) {
      if (answers[field.id] !== undefined) kept[field.id] = answers[field.id];
    }
  }

  return kept;
}
