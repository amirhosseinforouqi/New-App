import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSnapshot,
  compareOptions,
  driftFromCurrent,
  type ScenarioOption,
  type ScenarioSnapshot,
} from '../src/lib/deals/scenarios';
import { rankProducts, type DealProfile, type LenderProduct } from '../src/lib/lenders/matching';

const product = (overrides: Partial<LenderProduct>): LenderProduct => ({
  id: 'p1',
  lenderId: 'l1',
  lenderName: 'Test Trust',
  name: '5-year fixed',
  rateType: 'fixed',
  termYears: 5,
  postedRate: 4.79,
  minCreditScore: null,
  maxLtv: null,
  maxGds: null,
  maxTds: null,
  maxAmortization: null,
  minLoanAmount: null,
  maxLoanAmount: null,
  allowsInsured: true,
  allowsUninsured: true,
  allowsRental: true,
  allowsSelfEmployed: true,
  allowedProvinces: null,
  allowedDealTypes: null,
  notes: null,
  ...overrides,
});

const deal: DealProfile = {
  mortgageAmount: 600_000,
  propertyValue: 750_000,
  amortizationYears: 25,
  dealType: 'purchase',
  province: 'ON',
  occupancy: 'owner_occupied',
  creditScore: 720,
  isSelfEmployed: false,
  ratios: null,
};

const dealFacts = { mortgageAmount: 600_000, propertyValue: 750_000, amortizationYears: 25 };

describe('scenario snapshots', () => {
  it('freezes the numbers at capture', () => {
    const products = [product({ id: 'a', postedRate: 4.79 }), product({ id: 'b', postedRate: 5.29 })];
    const matches = rankProducts(products, deal);

    const snapshot = buildSnapshot(matches, ['a', 'b'], dealFacts);

    assert.equal(snapshot.options.length, 2);
    assert.equal(snapshot.options[0]!.postedRate, 4.79);
    assert.equal(snapshot.options[1]!.postedRate, 5.29);
    assert.ok(snapshot.options[0]!.monthlyPayment > 0);
    // The snapshot is a plain value, not a view over the products.
    assert.equal(typeof snapshot.capturedAt, 'string');
  });

  it('keeps the order the broker selected, not the ranked order', () => {
    // 'b' is the more expensive product, so ranking would put it second.
    const products = [product({ id: 'a', postedRate: 4.79 }), product({ id: 'b', postedRate: 5.29 })];
    const matches = rankProducts(products, deal);

    const snapshot = buildSnapshot(matches, ['b', 'a'], dealFacts);

    assert.deepEqual(
      snapshot.options.map((option) => option.productId),
      ['b', 'a'],
    );
  });

  it('skips ids with no matching product rather than emitting a hole', () => {
    const matches = rankProducts([product({ id: 'a' })], deal);
    const snapshot = buildSnapshot(matches, ['a', 'does-not-exist'], dealFacts);

    assert.equal(snapshot.options.length, 1);
    assert.equal(snapshot.options[0]!.productId, 'a');
  });

  it('records a product that does not fit, so a rejected option can still be shown', () => {
    const matches = rankProducts([product({ id: 'a', maxLtv: 50 })], deal);
    const snapshot = buildSnapshot(matches, ['a'], dealFacts);

    assert.equal(snapshot.options[0]!.fits, false);
  });
});

const option = (overrides: Partial<ScenarioOption>): ScenarioOption => ({
  productId: 'a',
  lenderName: 'Test Trust',
  productName: '5-year fixed',
  rateType: 'fixed',
  termYears: 5,
  postedRate: 4.79,
  monthlyPayment: 3400,
  totalInterestOverTerm: 130_000,
  balanceAtEndOfTerm: 530_000,
  ltv: 80,
  fits: true,
  ...overrides,
});

const snapshotOf = (options: ScenarioOption[]): ScenarioSnapshot => ({
  capturedAt: '2026-01-01T00:00:00.000Z',
  ...dealFacts,
  options,
});

describe('rate drift', () => {
  it('is empty while the table still agrees with the snapshot', () => {
    const snapshot = snapshotOf([option({ productId: 'a', postedRate: 4.79 })]);

    const drift = driftFromCurrent(snapshot, [{ id: 'a', postedRate: 4.79, isActive: true }]);

    assert.deepEqual(drift, []);
  });

  it('reports a rate that moved, with direction', () => {
    const snapshot = snapshotOf([option({ productId: 'a', postedRate: 4.79 })]);

    const drift = driftFromCurrent(snapshot, [{ id: 'a', postedRate: 4.99, isActive: true }]);

    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.quotedRate, 4.79);
    assert.equal(drift[0]!.currentRate, 4.99);
    assert.equal(drift[0]!.changePercent, 0.2);
    assert.equal(drift[0]!.unavailable, false);
  });

  it('reports a negative change when the rate came down', () => {
    const snapshot = snapshotOf([option({ productId: 'a', postedRate: 4.79 })]);

    const drift = driftFromCurrent(snapshot, [{ id: 'a', postedRate: 4.59, isActive: true }]);

    assert.equal(drift[0]!.changePercent, -0.2);
  });

  it('flags a retired product as unavailable, not as a rate change', () => {
    const snapshot = snapshotOf([option({ productId: 'a', postedRate: 4.79 })]);

    const drift = driftFromCurrent(snapshot, [{ id: 'a', postedRate: 4.79, isActive: false }]);

    assert.equal(drift[0]!.unavailable, true);
    assert.equal(drift[0]!.changePercent, null);
  });

  it('flags a product deleted from the table', () => {
    const snapshot = snapshotOf([option({ productId: 'a' })]);

    const drift = driftFromCurrent(snapshot, []);

    assert.equal(drift[0]!.unavailable, true);
    assert.equal(drift[0]!.currentRate, null);
  });

  it('ignores a difference below a hundredth of a percent', () => {
    const snapshot = snapshotOf([option({ productId: 'a', postedRate: 4.79 })]);

    const drift = driftFromCurrent(snapshot, [{ id: 'a', postedRate: 4.79000001, isActive: true }]);

    assert.deepEqual(drift, []);
  });
});

describe('comparing options', () => {
  it('ranks cheapest by cost over the term, not by rate', () => {
    // 'low-rate' has the better headline rate but leaves a much larger balance
    // to renew, which is exactly the trap the matcher exists to avoid.
    const comparison = compareOptions([
      option({
        productId: 'low-rate',
        postedRate: 4.5,
        totalInterestOverTerm: 120_000,
        balanceAtEndOfTerm: 560_000,
      }),
      option({
        productId: 'higher-rate',
        postedRate: 4.9,
        totalInterestOverTerm: 135_000,
        balanceAtEndOfTerm: 530_000,
      }),
    ]);

    assert.equal(comparison.cheapestOverTerm, 'higher-rate');
    assert.equal(comparison.spreadOverTerm, 15_000);
    assert.equal(comparison.termsDiffer, false);
  });

  it('refuses to name a cheapest across different term lengths', () => {
    // A 2-year accrues two years of interest against a 3-year's three, so the
    // shorter term always "wins" on total cost. Declaring it cheapest would be
    // an artefact of the arithmetic, not a fact about the products.
    const comparison = compareOptions([
      option({
        productId: 'two-year',
        termYears: 2,
        postedRate: 5.55,
        totalInterestOverTerm: 64_620,
        balanceAtEndOfTerm: 576_305,
      }),
      option({
        productId: 'three-year',
        termYears: 3,
        postedRate: 4.79,
        totalInterestOverTerm: 82_645,
        balanceAtEndOfTerm: 559_588,
      }),
    ]);

    assert.equal(comparison.termsDiffer, true);
    assert.equal(comparison.cheapestOverTerm, null);
    assert.equal(comparison.spreadOverTerm, 0);
    assert.deepEqual(comparison.termYears, [2, 3]);
  });

  it('still reports the lowest payment when terms differ', () => {
    // A monthly payment is a real figure whatever the term length, so this one
    // survives where the cost ranking does not.
    const comparison = compareOptions([
      option({ productId: 'two-year', termYears: 2, monthlyPayment: 3680 }),
      option({ productId: 'three-year', termYears: 3, monthlyPayment: 3418 }),
    ]);

    assert.equal(comparison.cheapestOverTerm, null);
    assert.equal(comparison.lowestPayment, 'three-year');
  });

  it('reports lowest payment separately from cheapest', () => {
    const comparison = compareOptions([
      option({
        productId: 'cheap-overall',
        monthlyPayment: 3600,
        totalInterestOverTerm: 100_000,
        balanceAtEndOfTerm: 500_000,
      }),
      option({
        productId: 'easy-cash-flow',
        monthlyPayment: 3100,
        totalInterestOverTerm: 140_000,
        balanceAtEndOfTerm: 540_000,
      }),
    ]);

    assert.equal(comparison.cheapestOverTerm, 'cheap-overall');
    assert.equal(comparison.lowestPayment, 'easy-cash-flow');
  });

  it('handles a single option without claiming a spread', () => {
    const comparison = compareOptions([option({ productId: 'only' })]);

    assert.equal(comparison.cheapestOverTerm, 'only');
    assert.equal(comparison.lowestPayment, 'only');
    assert.equal(comparison.spreadOverTerm, 0);
    assert.equal(comparison.termsDiffer, false);
  });

  it('returns nulls for an empty comparison rather than throwing', () => {
    const comparison = compareOptions([]);

    assert.equal(comparison.cheapestOverTerm, null);
    assert.equal(comparison.spreadOverTerm, 0);
  });
});
