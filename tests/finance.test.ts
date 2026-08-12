import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  amortizationSchedule,
  calculateInsurance,
  calculatePayment,
  minimumDownPayment,
  periodicRate,
  qualifyingRate,
} from '../src/lib/finance/mortgage';
import { calculateRatios, qualifyingIncome, GDS_LIMIT } from '../src/lib/finance/ratios';
import { calculateLandTransferTax } from '../src/lib/finance/land-transfer-tax';

describe('Canadian semi-annual compounding', () => {
  it('produces a lower periodic rate than naive monthly division', () => {
    // The whole point: 6%/12 = 0.005 would be the American answer.
    // Semi-annual compounding gives slightly less.
    const rate = periodicRate(6, 12);
    assert.ok(rate < 0.005, `expected < 0.005, got ${rate}`);
    assert.ok(rate > 0.0049, `expected > 0.0049, got ${rate}`);
  });

  it('returns zero for a zero rate', () => {
    assert.equal(periodicRate(0, 12), 0);
  });

  it('matches the published payment for a standard mortgage', () => {
    // $500,000 at 5.00% over 25 years, monthly. Canadian semi-annual
    // compounding gives ≈ $2,908 — the American formula would say ≈ $2,923.
    const { payment } = calculatePayment({
      principal: 500_000,
      annualRatePercent: 5,
      amortizationYears: 25,
    });
    assert.ok(Math.abs(payment - 2908) < 5, `expected ≈2908, got ${payment}`);
  });
});

describe('payment frequencies', () => {
  const base = { principal: 400_000, annualRatePercent: 5, amortizationYears: 25 } as const;

  it('biweekly monthly-equivalent is close to the monthly payment', () => {
    const monthly = calculatePayment({ ...base, frequency: 'monthly' });
    const biweekly = calculatePayment({ ...base, frequency: 'biweekly' });
    assert.ok(Math.abs(monthly.monthlyEquivalent - biweekly.monthlyEquivalent) < 5);
  });

  it('accelerated biweekly costs more per month but pays off sooner', () => {
    const monthly = calculatePayment({ ...base, frequency: 'monthly' });
    const accelerated = calculatePayment({ ...base, frequency: 'accelerated_biweekly' });

    assert.ok(accelerated.monthlyEquivalent > monthly.monthlyEquivalent);
    assert.ok(
      accelerated.numberOfPayments < 25 * 26,
      'accelerated schedule should retire the balance before full amortization',
    );
    assert.ok(accelerated.totalInterest < monthly.totalInterest);
  });

  it('handles a zero interest rate without dividing by zero', () => {
    const result = calculatePayment({ principal: 120_000, annualRatePercent: 0, amortizationYears: 10 });
    assert.equal(result.payment, 1000);
    assert.equal(result.totalInterest, 0);
  });

  it('returns zeros rather than NaN for an empty mortgage', () => {
    const result = calculatePayment({ principal: 0, annualRatePercent: 5, amortizationYears: 25 });
    assert.equal(result.payment, 0);
    assert.equal(result.monthlyEquivalent, 0);
  });
});

describe('amortization', () => {
  it('is mostly interest in year one', () => {
    const [first] = amortizationSchedule({
      principal: 500_000,
      annualRatePercent: 5,
      amortizationYears: 25,
    });
    assert.ok(first!.interestPaid > first!.principalPaid);
  });

  it('reaches a zero balance by the end', () => {
    const schedule = amortizationSchedule({
      principal: 300_000,
      annualRatePercent: 4,
      amortizationYears: 20,
    });
    assert.equal(schedule.length, 20);
    assert.ok(schedule[19]!.endingBalance < 1);
  });
});

describe('default insurance', () => {
  it('is not required at 20% down', () => {
    const result = calculateInsurance(500_000, 100_000);
    assert.equal(result.required, false);
    assert.equal(result.premium, 0);
  });

  it('applies the 4% tier at 5% down', () => {
    const result = calculateInsurance(500_000, 25_000);
    assert.equal(result.required, true);
    assert.equal(result.premiumRate, 4);
    assert.equal(result.premium, 19_000);
    assert.equal(result.totalMortgage, 494_000);
  });

  it('refuses above 95% LTV', () => {
    const result = calculateInsurance(500_000, 10_000);
    assert.equal(result.qualifies, false);
  });
});

describe('minimum down payment', () => {
  it('is 5% below $500k', () => {
    assert.equal(minimumDownPayment(400_000), 20_000);
  });

  it('is tiered between $500k and $1.5M', () => {
    // 5% of 500k + 10% of the next 200k
    assert.equal(minimumDownPayment(700_000), 45_000);
  });

  it('is 20% at $1.5M and above', () => {
    assert.equal(minimumDownPayment(1_500_000), 300_000);
  });
});

describe('stress test', () => {
  it('uses the floor when the contract rate is low', () => {
    assert.equal(qualifyingRate(2), 5.25);
  });

  it('uses rate + 2 when that is higher', () => {
    assert.equal(qualifyingRate(5), 7);
  });
});

describe('qualifying income', () => {
  it('takes salaried income at face value', () => {
    assert.equal(qualifyingIncome({ annualIncome: 90_000, employmentType: 'salaried' }), 90_000);
  });

  it('averages two years of self-employed income', () => {
    const income = qualifyingIncome({
      annualIncome: 100_000,
      priorYearIncome: 80_000,
      employmentType: 'self_employed',
    });
    assert.equal(income, 90_000);
  });

  it('does not average a declining year upward', () => {
    // Averaging 60k and 100k would give 80k — higher than the current year.
    // Lenders use the lower figure, because the trend is the risk.
    const income = qualifyingIncome({
      annualIncome: 60_000,
      priorYearIncome: 100_000,
      employmentType: 'self_employed',
    });
    assert.equal(income, 60_000);
  });
});

describe('GDS / TDS / LTV', () => {
  const strongFile = {
    mortgageAmount: 400_000,
    annualRatePercent: 5,
    amortizationYears: 25,
    propertyValue: 500_000,
    annualPropertyTax: 4_800,
    monthlyHeat: 100,
    monthlyCondoFees: 0,
    incomes: [{ annualIncome: 180_000, employmentType: 'salaried' }],
    liabilities: [],
  };

  it('computes LTV correctly', () => {
    assert.equal(calculateRatios(strongFile).ltv, 80);
  });

  it('passes both ratios on a strong file', () => {
    const result = calculateRatios(strongFile);
    assert.equal(result.gdsPasses, true);
    assert.equal(result.tdsPasses, true);
    assert.ok(result.gds < GDS_LIMIT);
  });

  it('qualifies at the stress-test rate, not the contract rate', () => {
    const stressed = calculateRatios(strongFile);
    const contract = calculateRatios({ ...strongFile, useStressTest: false });

    assert.equal(stressed.qualifyingRatePercent, 7);
    assert.equal(contract.qualifyingRatePercent, 5);
    assert.ok(stressed.gds > contract.gds, 'stress test must produce a higher GDS');
  });

  it('counts only half of condo fees', () => {
    const withCondo = calculateRatios({ ...strongFile, monthlyCondoFees: 600 });
    assert.equal(withCondo.condoFeesCounted, 300);
  });

  it('excludes liabilities being paid out on closing', () => {
    const withDebt = calculateRatios({
      ...strongFile,
      liabilities: [
        { monthlyPayment: 500 },
        { monthlyPayment: 900, payoutOnClosing: true },
      ],
    });
    assert.equal(withDebt.otherDebtPayments, 500);
  });

  it('fails TDS when debt load is heavy', () => {
    const heavy = calculateRatios({
      ...strongFile,
      incomes: [{ annualIncome: 70_000, employmentType: 'salaried' }],
      liabilities: [{ monthlyPayment: 1_200 }],
    });
    assert.equal(heavy.tdsPasses, false);
  });

  it('returns zeros rather than NaN when no income is entered', () => {
    const empty = calculateRatios({ ...strongFile, incomes: [] });
    assert.equal(empty.gds, 0);
    assert.equal(empty.tds, 0);
    assert.equal(empty.gdsPasses, false);
    assert.ok(empty.warnings.some((w) => w.includes('No income')));
  });

  it('warns when LTV requires insurance', () => {
    const high = calculateRatios({ ...strongFile, mortgageAmount: 450_000 });
    assert.ok(high.warnings.some((w) => w.includes('default insurance')));
  });

  it('computes a max mortgage that actually keeps GDS inside the limit', () => {
    const result = calculateRatios(strongFile);
    assert.ok(result.maxMortgageByRatios > 0);

    const atMax = calculateRatios({ ...strongFile, mortgageAmount: result.maxMortgageByRatios });
    assert.ok(atMax.gds <= GDS_LIMIT + 0.1, `GDS at max was ${atMax.gds}`);
  });

  it('returns a zero max mortgage when fixed costs already exceed the budget', () => {
    const broke = calculateRatios({
      ...strongFile,
      incomes: [{ annualIncome: 20_000, employmentType: 'salaried' }],
      annualPropertyTax: 12_000,
    });
    assert.equal(broke.maxMortgageByRatios, 0);
  });
});

describe('land transfer tax', () => {
  it('calculates Ontario tax on an $800k purchase', () => {
    // 55,000×0.5% + 195,000×1% + 150,000×1.5% + 400,000×2% = 12,475
    const result = calculateLandTransferTax({ purchasePrice: 800_000, province: 'ON' });
    assert.equal(result.provincialTax, 12_475);
    assert.equal(result.municipalTax, 0);
  });

  it('adds the municipal tax in Toronto', () => {
    const result = calculateLandTransferTax({
      purchasePrice: 800_000,
      province: 'ON',
      city: 'Toronto',
    });
    assert.equal(result.municipalTax, 12_475);
    assert.equal(result.totalTax, 24_950);
  });

  it('caps the first-time buyer rebate', () => {
    const result = calculateLandTransferTax({
      purchasePrice: 800_000,
      province: 'ON',
      city: 'Toronto',
      isFirstTimeBuyer: true,
    });
    assert.equal(result.provincialRebate, 4_000);
    assert.equal(result.municipalRebate, 4_475);
    assert.equal(result.totalTax, 24_950 - 8_475);
  });

  it('fully exempts a BC first-time buyer under the threshold', () => {
    const result = calculateLandTransferTax({
      purchasePrice: 450_000,
      province: 'BC',
      isFirstTimeBuyer: true,
    });
    assert.equal(result.totalTax, 0);
  });

  it('phases out the BC exemption above the threshold', () => {
    const result = calculateLandTransferTax({
      purchasePrice: 700_000,
      province: 'BC',
      isFirstTimeBuyer: true,
    });
    assert.ok(result.provincialRebate > 0);
    assert.ok(result.provincialRebate < result.provincialTax);
  });

  it('says so plainly where there is no LTT', () => {
    const result = calculateLandTransferTax({ purchasePrice: 600_000, province: 'AB' });
    assert.equal(result.supported, true);
    assert.equal(result.totalTax, 0);
    assert.ok(result.note.includes('No land transfer tax'));
  });

  it('does not invent a number for an unimplemented province', () => {
    const result = calculateLandTransferTax({ purchasePrice: 600_000, province: 'NS' });
    assert.equal(result.supported, false);
    assert.ok(result.note.includes('not calculated'));
  });
});
