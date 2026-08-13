/**
 * Commission on a funded deal, and how it divides.
 *
 * A lender pays a finder's fee as a percentage of the funded amount, sometimes
 * with a volume bonus on top. The brokerage then splits that between the agent
 * who wrote it, anyone who referred it, and itself.
 *
 * The rule that decides whether this is correct or a support ticket: the splits
 * must total exactly the commission, to the cent. Percentages of a dollar
 * figure do not divide evenly — 33.33% three ways leaves a cent — so the
 * remainder is assigned deterministically to the largest share rather than
 * being rounded away. Money that vanishes in rounding is money someone notices.
 */

export interface CommissionInput {
  fundedAmount: number;
  findersFeePercent: number;
  volumeBonus?: number;
}

export interface SplitInput {
  payeeName: string;
  brokerId?: string | null;
  percent: number;
  role?: string;
}

export interface CalculatedSplit extends SplitInput {
  amount: number;
}

export interface CommissionResult {
  fundedAmount: number;
  findersFeePercent: number;
  baseCommission: number;
  volumeBonus: number;
  totalCommission: number;
  splits: CalculatedSplit[];
  /** Non-fatal problems worth showing the person entering this. */
  warnings: string[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const cents = (value: number) => Math.round(value * 100);

export function calculateCommission(
  input: CommissionInput,
  splits: SplitInput[],
): CommissionResult {
  const warnings: string[] = [];

  const fundedAmount = Math.max(input.fundedAmount, 0);
  const findersFeePercent = Math.max(input.findersFeePercent, 0);
  const volumeBonus = Math.max(input.volumeBonus ?? 0, 0);

  const baseCommission = round2((fundedAmount * findersFeePercent) / 100);
  const totalCommission = round2(baseCommission + volumeBonus);

  const percentTotal = splits.reduce((sum, split) => sum + split.percent, 0);

  if (splits.length === 0) {
    warnings.push('No splits defined — the whole commission is unallocated.');
  } else if (Math.abs(percentTotal - 100) > 0.001) {
    warnings.push(
      `Splits total ${round2(percentTotal)}%, not 100%. ` +
        `${percentTotal < 100 ? 'Some commission is unallocated.' : 'More is allocated than exists.'}`,
    );
  }

  // Work in integer cents so the split arithmetic is exact.
  const totalCents = cents(totalCommission);
  const allocated: number[] = splits.map((split) =>
    Math.floor((totalCents * split.percent) / 100),
  );

  // Hand the rounding remainder to the largest share. Deterministic, and it
  // lands where a cent is least noticeable rather than disappearing.
  const remainder = totalCents - allocated.reduce((sum, value) => sum + value, 0);
  if (remainder !== 0 && allocated.length > 0) {
    let largest = 0;
    for (let i = 1; i < splits.length; i += 1) {
      if (splits[i]!.percent > splits[largest]!.percent) largest = i;
    }
    allocated[largest] = allocated[largest]! + remainder;
  }

  const calculated: CalculatedSplit[] = splits.map((split, index) => ({
    ...split,
    amount: allocated[index]! / 100,
  }));

  const distributed = calculated.reduce((sum, split) => sum + split.amount, 0);
  if (splits.length > 0 && Math.abs(distributed - totalCommission) > 0.001) {
    // Should be unreachable given the remainder handling above; if it ever
    // fires, the arithmetic is wrong and silence would be the worst outcome.
    warnings.push(
      `Split amounts total $${round2(distributed)} against a commission of $${totalCommission}.`,
    );
  }

  return {
    fundedAmount,
    findersFeePercent,
    baseCommission,
    volumeBonus,
    totalCommission,
    splits: calculated,
    warnings,
  };
}

/**
 * The usual arrangement, as a starting point.
 *
 * An agent on a 70/30 split with the brokerage, and where the deal came from a
 * referring agent, a slice off the top for them. These are defaults to edit,
 * not policy — every brokerage does this differently.
 */
export function defaultSplits(options: {
  agentName: string;
  agentId?: string | null;
  agentSplitPercent: number;
  brokerageName?: string;
  referrerName?: string | null;
  referrerPercent?: number;
}): SplitInput[] {
  const referrerPercent = options.referrerName ? (options.referrerPercent ?? 15) : 0;
  const remaining = 100 - referrerPercent;

  const agentPercent = round2((remaining * options.agentSplitPercent) / 100);
  const brokeragePercent = round2(remaining - agentPercent);

  const splits: SplitInput[] = [
    {
      payeeName: options.agentName,
      brokerId: options.agentId ?? null,
      percent: agentPercent,
      role: 'agent',
    },
    {
      payeeName: options.brokerageName ?? 'Brokerage',
      percent: brokeragePercent,
      role: 'brokerage',
    },
  ];

  if (options.referrerName && referrerPercent > 0) {
    splits.unshift({
      payeeName: options.referrerName,
      percent: referrerPercent,
      role: 'referrer',
    });
  }

  return splits;
}

/** Roll-up for the team performance view. */
export interface CommissionRow {
  brokerId: string | null;
  payeeName: string;
  amount: number;
  status: string;
  fundedAmount: number;
}

export function summariseByPayee(rows: CommissionRow[]) {
  const byPayee = new Map<
    string,
    { payeeName: string; brokerId: string | null; paid: number; pending: number; volume: number; deals: number }
  >();

  for (const row of rows) {
    const key = row.brokerId ?? row.payeeName;
    const entry = byPayee.get(key) ?? {
      payeeName: row.payeeName,
      brokerId: row.brokerId,
      paid: 0,
      pending: 0,
      volume: 0,
      deals: 0,
    };

    if (row.status === 'paid') entry.paid += row.amount;
    else entry.pending += row.amount;

    entry.volume += row.fundedAmount;
    entry.deals += 1;
    byPayee.set(key, entry);
  }

  return [...byPayee.values()]
    .map((entry) => ({
      ...entry,
      paid: round2(entry.paid),
      pending: round2(entry.pending),
      volume: round2(entry.volume),
      total: round2(entry.paid + entry.pending),
    }))
    .sort((a, b) => b.total - a.total);
}
