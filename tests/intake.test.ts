import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INTAKE_STEPS,
  missingRequired,
  visibleFields,
  visibleSteps,
  type Answers,
} from '../src/lib/intake/form';
import {
  money,
  pruneToVisible,
  requestedMortgage,
  validateSubmission,
} from '../src/lib/intake/mapping';

const goalStep = INTAKE_STEPS[0]!;
const propertyStep = INTAKE_STEPS.find((step) => step.id === 'property')!;
const incomeStep = INTAKE_STEPS.find((step) => step.id === 'income')!;

describe('bilingual coverage', () => {
  it('has both languages on every label in the form', () => {
    for (const step of INTAKE_STEPS) {
      assert.ok(step.title.en && step.title.fr, `step ${step.id} is missing a title`);

      for (const field of step.fields) {
        assert.ok(field.label.en, `${field.id} has no English label`);
        assert.ok(field.label.fr, `${field.id} has no French label`);

        for (const option of field.options ?? []) {
          assert.ok(option.label.en, `${field.id}/${option.value} has no English label`);
          assert.ok(option.label.fr, `${field.id}/${option.value} has no French label`);
        }
      }
    }
  });

  it('never leaves French as a copy of the English', () => {
    // A stray untranslated string is invisible in review but glaring to a
    // francophone borrower, who then stops trusting the form with their income.
    const identical: string[] = [];

    for (const step of INTAKE_STEPS) {
      for (const field of step.fields) {
        // Proper nouns and true cognates are legitimately identical; only flag
        // strings long enough that a real translation would have differed.
        if (field.label.en === field.label.fr && field.label.en.length > 24) {
          identical.push(field.id);
        }
      }
    }

    assert.deepEqual(identical, []);
  });

  it('gives every field a unique id across the whole form', () => {
    const ids = INTAKE_STEPS.flatMap((step) => step.fields.map((field) => field.id));
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('conditional branching', () => {
  it('asks about first-time buyer status only on a purchase', () => {
    const purchase = visibleFields(goalStep, 'short', { dealType: 'purchase' });
    const renewal = visibleFields(goalStep, 'short', { dealType: 'renewal' });

    assert.ok(purchase.some((field) => field.id === 'firstTimeBuyer'));
    assert.ok(!renewal.some((field) => field.id === 'firstTimeBuyer'));
  });

  it('asks for a down payment on a purchase and a balance on a refinance', () => {
    const purchase = visibleFields(propertyStep, 'short', { dealType: 'purchase' });
    assert.ok(purchase.some((field) => field.id === 'downPayment'));
    assert.ok(!purchase.some((field) => field.id === 'propertyValue'));

    const refinance = visibleFields(propertyStep, 'short', { dealType: 'refinance' });
    assert.ok(refinance.some((field) => field.id === 'propertyValue'));
    assert.ok(!refinance.some((field) => field.id === 'downPayment'));
  });

  it('asks for condo fees only when the property is a condo', () => {
    const condo = visibleFields(propertyStep, 'short', { propertyType: 'condo' });
    const house = visibleFields(propertyStep, 'short', { propertyType: 'detached' });

    assert.ok(condo.some((field) => field.id === 'monthlyCondoFees'));
    assert.ok(!house.some((field) => field.id === 'monthlyCondoFees'));
  });

  it('asks a self-employed borrower for a prior year, and a salaried one not', () => {
    const selfEmployed = visibleFields(incomeStep, 'short', { employmentType: 'self_employed' });
    const salaried = visibleFields(incomeStep, 'short', { employmentType: 'salaried' });

    assert.ok(selfEmployed.some((field) => field.id === 'priorYearIncome'));
    assert.ok(!salaried.some((field) => field.id === 'priorYearIncome'));
  });

  it('skips a step entirely when nothing in it applies', () => {
    // The existing-mortgage step is all refinance/renewal questions. A buyer
    // should never see an empty page with a Continue button on it.
    const buying = visibleSteps('short', { dealType: 'purchase' });
    const renewing = visibleSteps('short', { dealType: 'renewal' });

    assert.ok(!buying.some((step) => step.id === 'existing'));
    assert.ok(renewing.some((step) => step.id === 'existing'));
  });
});

describe('tiers', () => {
  it('keeps the quick estimate genuinely quick', () => {
    const fields = visibleSteps('ez', { dealType: 'purchase' }).flatMap((step) =>
      visibleFields(step, 'ez', { dealType: 'purchase' }),
    );
    assert.ok(fields.length <= 12, `ez tier grew to ${fields.length} fields`);
  });

  it('asks progressively more at each tier', () => {
    const answers: Answers = { dealType: 'purchase', propertyType: 'condo' };
    const count = (tier: 'ez' | 'short' | 'long') =>
      visibleSteps(tier, answers).flatMap((step) => visibleFields(step, tier, answers)).length;

    assert.ok(count('ez') < count('short'));
    assert.ok(count('short') < count('long'));
  });

  it('never requires something the tier does not ask', () => {
    for (const tier of ['ez', 'short', 'long'] as const) {
      for (const step of INTAKE_STEPS) {
        if (!step.tiers.includes(tier)) continue;
        for (const field of missingRequired(step, tier, {})) {
          assert.ok(field.tiers.includes(tier), `${field.id} required outside its tier`);
        }
      }
    }
  });
});

describe('server-side validation', () => {
  const complete: Answers = {
    dealType: 'purchase',
    timeline: 'asap',
    fullName: 'Jordan Fisher',
    email: 'jordan@example.ca',
    purchasePrice: '600000',
    downPayment: '120000',
    propertyProvince: 'ON',
    employmentType: 'salaried',
    annualIncome: '110000',
    consent: true,
  };

  it('passes a complete short application', () => {
    assert.deepEqual(validateSubmission('short', complete), []);
  });

  it('catches an unticked consent box', () => {
    const { consent: _consent, ...withoutConsent } = complete;
    assert.deepEqual(validateSubmission('short', withoutConsent), ['consent']);
  });

  it('treats a checkbox as unanswered when it is false, not just absent', () => {
    assert.deepEqual(validateSubmission('short', { ...complete, consent: false }), ['consent']);
  });

  it('requires the co-borrower’s email once a co-borrower is declared', () => {
    const missing = validateSubmission('short', { ...complete, hasCoBorrower: 'yes' });
    assert.deepEqual(missing.sort(), ['coBorrowerEmail', 'coBorrowerName']);
  });

  it('does not require refinance fields from a buyer', () => {
    assert.ok(!validateSubmission('short', complete).includes('existingBalance'));
  });

  it('requires the balance from someone refinancing', () => {
    const refinancing = { ...complete, dealType: 'refinance', propertyValue: '800000' };
    assert.ok(validateSubmission('short', refinancing).includes('existingBalance'));
  });
});

describe('answer pruning', () => {
  it('drops a stale answer once the question that asked it disappears', () => {
    // Picked "condo", entered fees, changed to "detached". The fee must not
    // survive into the GDS calculation.
    const kept = pruneToVisible('short', {
      dealType: 'purchase',
      propertyType: 'detached',
      monthlyCondoFees: '640',
    });

    assert.equal(kept.monthlyCondoFees, undefined);
    assert.equal(kept.propertyType, 'detached');
  });

  it('drops answers belonging to a richer tier', () => {
    const kept = pruneToVisible('ez', {
      dealType: 'purchase',
      annualIncome: '110000',
    });

    assert.equal(kept.annualIncome, undefined);
  });

  it('will not carry an unexpected key through to the database', () => {
    const kept = pruneToVisible('short', { dealType: 'purchase', isAdmin: true });
    assert.equal(kept.isAdmin, undefined);
  });
});

describe('money parsing', () => {
  it('reads what a person actually types', () => {
    assert.equal(money({ a: '875,000' }, 'a'), 875000);
    assert.equal(money({ a: '$875 000' }, 'a'), 875000);
    assert.equal(money({ a: '875000.50' }, 'a'), 875000.5);
    assert.equal(money({ a: 875000 }, 'a'), 875000);
  });

  it('returns null rather than NaN for nothing useful', () => {
    assert.equal(money({}, 'a'), null);
    assert.equal(money({ a: '' }, 'a'), null);
    assert.equal(money({ a: 'about half a million' }, 'a'), null);
  });
});

describe('requested mortgage', () => {
  it('is price minus down payment on a purchase', () => {
    assert.equal(
      requestedMortgage({ dealType: 'purchase', purchasePrice: '875,000', downPayment: '120000' }),
      755_000,
    );
  });

  it('never goes negative when the down payment exceeds the price', () => {
    assert.equal(
      requestedMortgage({ dealType: 'purchase', purchasePrice: '400000', downPayment: '450000' }),
      0,
    );
  });

  it('is the balance plus new funds on a refinance', () => {
    assert.equal(
      requestedMortgage({
        dealType: 'refinance',
        existingBalance: '310000',
        additionalFundsNeeded: '60000',
      }),
      370_000,
    );
  });

  it('is the balance alone on a renewal', () => {
    assert.equal(requestedMortgage({ dealType: 'renewal', existingBalance: '412500' }), 412_500);
  });

  it('is null, not zero, when there is no property in mind yet', () => {
    assert.equal(requestedMortgage({ dealType: 'preapproval' }), null);
  });
});
