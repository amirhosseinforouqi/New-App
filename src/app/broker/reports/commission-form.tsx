'use client';

/**
 * Recording a commission on a funded deal.
 *
 * The preview is computed by importing `calculateCommission` — the same pure
 * function the route handler runs on submit. That is deliberate: a preview
 * written separately from the thing it previews drifts, and the first person to
 * notice is the agent whose pay does not match the number they were shown.
 *
 * Splits are entered as percentages and shown as dollars, because percentages
 * are how brokerages talk about the arrangement and dollars are what people
 * check. The engine assigns the rounding remainder to the largest share rather
 * than letting a cent evaporate, so the column always totals the commission
 * exactly; if it ever did not, the warning below would say so rather than the
 * form quietly balancing itself.
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { calculateCommission, defaultSplits } from '@/lib/commissions/calculate';

export interface FundedDeal {
  id: string;
  reference: string;
  mortgageAmount: number | null;
}

export interface Payee {
  id: string;
  fullName: string;
  commissionSplitPercent: number;
}

interface SplitRow {
  payeeName: string;
  brokerId: string | null;
  percent: string;
  role: string;
}

const money = (value: number) =>
  value.toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });

const ROLES = ['agent', 'brokerage', 'referrer', 'assistant'];

export function CommissionForm({
  deals,
  team,
  brokerageName,
}: {
  deals: FundedDeal[];
  team: Payee[];
  brokerageName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dealId, setDealId] = useState(deals[0]?.id ?? '');
  const [fundedAmount, setFundedAmount] = useState(
    deals[0]?.mortgageAmount != null ? String(deals[0].mortgageAmount) : '',
  );
  const [findersFeePercent, setFindersFeePercent] = useState('0.85');
  const [volumeBonus, setVolumeBonus] = useState('');

  const [splits, setSplits] = useState<SplitRow[]>(() =>
    defaultSplits({
      agentName: team[0]?.fullName ?? 'Agent',
      agentId: team[0]?.id ?? null,
      agentSplitPercent: team[0]?.commissionSplitPercent ?? 70,
      brokerageName,
    })
      // An owner-operator on a 100% split leaves the brokerage row at 0%. A
      // payee owed nothing is not a payee, and storing the row would put a $0
      // line in the payout table for someone to wonder about later.
      .filter((split) => split.percent > 0)
      .map((split) => ({
        payeeName: split.payeeName,
        brokerId: split.brokerId ?? null,
        percent: String(split.percent),
        role: split.role ?? 'agent',
      })),
  );

  // The same calculation the server will run, on every keystroke.
  const preview = useMemo(
    () =>
      calculateCommission(
        {
          fundedAmount: Number(fundedAmount) || 0,
          findersFeePercent: Number(findersFeePercent) || 0,
          volumeBonus: Number(volumeBonus) || 0,
        },
        splits.map((split) => ({
          payeeName: split.payeeName,
          brokerId: split.brokerId,
          percent: Number(split.percent) || 0,
          role: split.role,
        })),
      ),
    [fundedAmount, findersFeePercent, volumeBonus, splits],
  );

  const updateSplit = (index: number, patch: Partial<SplitRow>) =>
    setSplits((current) =>
      current.map((split, i) => (i === index ? { ...split, ...patch } : split)),
    );

  function selectDeal(id: string) {
    setDealId(id);
    const deal = deals.find((item) => item.id === id);
    // Funded amount is prefilled from the mortgage but stays editable — what a
    // lender actually advances is often not what was applied for.
    if (deal?.mortgageAmount != null) setFundedAmount(String(deal.mortgageAmount));
  }

  async function submit() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/broker/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'record_commission',
          dealId,
          fundedAmount: Number(fundedAmount) || 0,
          findersFeePercent: Number(findersFeePercent) || 0,
          volumeBonus: Number(volumeBonus) || 0,
          splits: splits.map((split) => ({
            payeeName: split.payeeName,
            brokerId: split.brokerId,
            percent: Number(split.percent) || 0,
            role: split.role,
          })),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not work.');
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setPending(false);
    }
  }

  if (deals.length === 0) {
    return (
      <p className="field-hint mt-3">
        Every funded deal already has a commission recorded. New ones appear here once a deal
        reaches Funded.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary mt-4" onClick={() => setOpen(true)}>
        Record a commission
      </button>
    );
  }

  const percentTotal = splits.reduce((sum, split) => sum + (Number(split.percent) || 0), 0);

  return (
    <div className="mt-4 rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-4">
      {error && (
        <div className="alert alert-error mb-3" role="alert">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="c-deal">
            Deal
          </label>
          <select
            id="c-deal"
            className="input"
            value={dealId}
            onChange={(event) => selectDeal(event.target.value)}
          >
            {deals.map((deal) => (
              <option key={deal.id} value={deal.id}>
                {deal.reference}
                {deal.mortgageAmount != null && ` — ${money(deal.mortgageAmount)}`}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="c-funded">
            Funded amount
          </label>
          <input
            id="c-funded"
            className="input tabular-nums"
            inputMode="decimal"
            value={fundedAmount}
            onChange={(event) => setFundedAmount(event.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="c-fee">
            Finder&rsquo;s fee %
          </label>
          <input
            id="c-fee"
            className="input tabular-nums"
            inputMode="decimal"
            value={findersFeePercent}
            onChange={(event) => setFindersFeePercent(event.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="c-bonus">
            Volume bonus
          </label>
          <input
            id="c-bonus"
            className="input tabular-nums"
            inputMode="decimal"
            value={volumeBonus}
            onChange={(event) => setVolumeBonus(event.target.value)}
            placeholder="0"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <p className="label mb-0">Splits</p>
        <p className="text-[13px] tabular-nums text-[var(--color-ink-500)]">
          {money(preview.baseCommission)} fee
          {preview.volumeBonus > 0 && ` + ${money(preview.volumeBonus)} bonus`} ={' '}
          <strong className="text-[var(--color-ink-900)]">{money(preview.totalCommission)}</strong>
        </p>
      </div>

      <div className="mt-2 space-y-2">
        {splits.map((split, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_7rem_7rem_6rem_2rem]">
            <div>
              <input
                className="input"
                value={split.payeeName}
                aria-label={`Payee ${index + 1}`}
                list="commission-payees"
                onChange={(event) => {
                  const name = event.target.value;
                  // Matching a team member by name links the split to their
                  // broker id, which is what makes the per-person roll-up work.
                  const member = team.find((person) => person.fullName === name);
                  updateSplit(index, { payeeName: name, brokerId: member?.id ?? null });
                }}
              />
            </div>
            <input
              className="input tabular-nums"
              inputMode="decimal"
              aria-label={`Percent for ${split.payeeName || `payee ${index + 1}`}`}
              value={split.percent}
              onChange={(event) => updateSplit(index, { percent: event.target.value })}
            />
            <select
              className="input"
              aria-label={`Role for ${split.payeeName || `payee ${index + 1}`}`}
              value={split.role}
              onChange={(event) => updateSplit(index, { role: event.target.value })}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <span className="self-center text-right text-[13px] tabular-nums">
              {money(preview.splits[index]?.amount ?? 0)}
            </span>
            <button
              type="button"
              className="self-center text-[var(--color-ink-400)] hover:text-[var(--color-danger-600)]"
              aria-label={`Remove ${split.payeeName || `payee ${index + 1}`}`}
              disabled={splits.length === 1}
              onClick={() => setSplits((current) => current.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <datalist id="commission-payees">
        {team.map((person) => (
          <option key={person.id} value={person.fullName} />
        ))}
        <option value={brokerageName} />
      </datalist>

      <button
        type="button"
        className="mt-2 text-[13px] text-[var(--color-accent-700)] hover:underline"
        onClick={() =>
          setSplits((current) => [
            ...current,
            { payeeName: '', brokerId: null, percent: '0', role: 'referrer' },
          ])
        }
      >
        + Add a payee
      </button>

      {preview.warnings.length > 0 && (
        <div className="alert alert-warn mt-3">
          {preview.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary flex-1"
          // Splits that do not total 100% would leave commission unallocated or
          // over-allocated. The engine warns rather than throws, so the block
          // belongs here.
          disabled={
            pending ||
            !dealId ||
            Math.abs(percentTotal - 100) > 0.001 ||
            splits.some((split) => split.payeeName.trim() === '')
          }
          onClick={() => void submit()}
        >
          {pending ? 'Recording…' : `Record ${money(preview.totalCommission)}`}
        </button>
      </div>

      <p className="field-hint">
        Recording again on the same deal replaces the previous entry rather than adding a second
        payout to the file.
      </p>
    </div>
  );
}
