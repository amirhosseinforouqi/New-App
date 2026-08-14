'use client';

/**
 * The lender and product table.
 *
 * Every qualification field is optional, and the form says what blank means
 * beside each one. That is not politeness — a broker who assumes a blank
 * minimum credit score means "0 required" will fill in 600 everywhere and
 * quietly exclude every file where no bureau has been pulled yet.
 *
 * Rates get their own inline editor because they move weekly and are the only
 * field anyone edits routinely; separating them means a rate change cannot
 * accidentally blank a rule.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface LenderRow {
  id: string;
  name: string;
  lenderType: string;
  productCount: number;
}

export interface ProductRow {
  id: string;
  lenderId: string;
  lenderName: string;
  name: string;
  rateType: string;
  termYears: number;
  postedRate: number;
  minCreditScore: number | null;
  maxLtv: number | null;
  maxAmortization: number | null;
  allowsInsured: boolean;
  allowsUninsured: boolean;
  allowsSelfEmployed: boolean;
  isActive: boolean;
}

const LENDER_TYPES = [
  { value: 'a_lender', label: 'A lender (bank)' },
  { value: 'monoline', label: 'Monoline' },
  { value: 'credit_union', label: 'Credit union' },
  { value: 'b_lender', label: 'B lender (alternative)' },
  { value: 'private', label: 'Private' },
];

export function LenderPanel({ lenders, products }: { lenders: LenderRow[]; products: ProductRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingLender, setAddingLender] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [rateValue, setRateValue] = useState('');

  async function post(body: Record<string, unknown>, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch('/api/broker/lenders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'That did not work.');
        return null;
      }
      router.refresh();
      return data as Record<string, unknown>;
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Lenders</h2>
          <button
            type="button"
            className="btn btn-secondary px-3 py-1.5 text-[13px]"
            onClick={() => setAddingLender((current) => !current)}
          >
            {addingLender ? 'Cancel' : 'Add lender'}
          </button>
        </div>

        {addingLender && <LenderForm pending={pending === 'lender'} onSubmit={(v) => void post({ action: 'create_lender', ...v }, 'lender').then(() => setAddingLender(false))} />}

        {lenders.length === 0 ? (
          <p className="field-hint mt-3">
            None yet. Add the lenders you actually place business with — the matching engine only
            considers what is here.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-line)]">
            {lenders.map((lender) => (
              <li key={lender.id} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="font-medium">{lender.name}</span>
                <span className="text-[var(--color-ink-400)]">
                  {LENDER_TYPES.find((t) => t.value === lender.lenderType)?.label ??
                    lender.lenderType}
                </span>
                <span className="ml-auto tabular-nums text-[var(--color-ink-500)]">
                  {lender.productCount} product{lender.productCount === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Products</h2>
          <button
            type="button"
            className="btn btn-secondary px-3 py-1.5 text-[13px]"
            disabled={lenders.length === 0}
            onClick={() => setAddingProduct((current) => !current)}
          >
            {addingProduct ? 'Cancel' : 'Add product'}
          </button>
        </div>

        {lenders.length === 0 && (
          <p className="field-hint mt-2">Add a lender first.</p>
        )}

        {addingProduct && (
          <ProductForm
            lenders={lenders}
            pending={pending === 'product'}
            onSubmit={(v) =>
              void post({ action: 'create_product', ...v }, 'product').then(() =>
                setAddingProduct(false),
              )
            }
          />
        )}

        {products.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                {/*
                  Horizontal padding is not decoration here: a right-aligned
                  numeric column immediately followed by a left-aligned text one
                  renders as "2y<=75% LTV" with no gap at all.
                */}
                <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-500)] [&>th]:px-3 [&>th:first-child]:pl-0 [&>th:last-child]:pr-0">
                  <th className="py-2 font-medium">Product</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                  <th className="py-2 text-right font-medium">Term</th>
                  <th className="py-2 font-medium">Rules</th>
                  <th className="py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr
                    key={product.id}
                    className={
                      'border-b border-[var(--color-line)] last:border-0 ' +
                      '[&>td]:px-3 [&>td:first-child]:pl-0 [&>td:last-child]:pr-0 ' +
                      (product.isActive ? '' : 'opacity-50')
                    }
                  >
                    <td className="py-2">
                      <span className="font-medium">{product.lenderName}</span>
                      <span className="block text-[12px] text-[var(--color-ink-400)]">
                        {product.name} · {product.rateType}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {editingRate === product.id ? (
                        <input
                          className="input w-20 py-1 text-right text-[13px]"
                          value={rateValue}
                          autoFocus
                          inputMode="decimal"
                          aria-label={`Rate for ${product.name}`}
                          onChange={(event) => setRateValue(event.target.value)}
                          onBlur={() => setEditingRate(null)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              void post(
                                {
                                  action: 'update_rate',
                                  productId: product.id,
                                  postedRate: Number(rateValue),
                                },
                                product.id,
                              );
                              setEditingRate(null);
                            }
                            if (event.key === 'Escape') setEditingRate(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="underline decoration-dotted underline-offset-2"
                          onClick={() => {
                            setEditingRate(product.id);
                            setRateValue(String(product.postedRate));
                          }}
                        >
                          {product.postedRate}%
                        </button>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{product.termYears}y</td>
                    <td className="py-2 text-[12px] text-[var(--color-ink-500)]">
                      {[
                        product.minCreditScore != null && `${product.minCreditScore}+ score`,
                        product.maxLtv != null && `≤${product.maxLtv}% LTV`,
                        product.maxAmortization != null && `≤${product.maxAmortization}y amort`,
                        !product.allowsInsured && 'uninsured only',
                        !product.allowsUninsured && 'insured only',
                        !product.allowsSelfEmployed && 'no self-employed',
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'no constraints'}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        className="text-[12px] text-[var(--color-ink-400)] underline hover:text-[var(--color-ink-700)]"
                        disabled={pending === product.id}
                        onClick={() =>
                          void post(
                            {
                              action: 'set_product_active',
                              productId: product.id,
                              isActive: !product.isActive,
                            },
                            product.id,
                          )
                        }
                      >
                        {product.isActive ? 'Retire' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint">
              Click a rate to edit it. Retired products stop appearing in matching but stay on any
              deal already compared against them.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function LenderForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState('');
  const [lenderType, setLenderType] = useState('a_lender');
  const [submissionEmail, setSubmissionEmail] = useState('');

  return (
    <div className="mt-4 rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="lender-name">
            Name
          </label>
          <input
            id="lender-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="lender-type">
            Type
          </label>
          <select
            id="lender-type"
            className="input"
            value={lenderType}
            onChange={(event) => setLenderType(event.target.value)}
          >
            {LENDER_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="lender-email">
            Submission email
          </label>
          <input
            id="lender-email"
            type="email"
            className="input"
            value={submissionEmail}
            onChange={(event) => setSubmissionEmail(event.target.value)}
          />
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary mt-3"
        disabled={pending || name.trim() === ''}
        onClick={() => onSubmit({ name, lenderType, submissionEmail })}
      >
        {pending ? 'Adding…' : 'Add lender'}
      </button>
    </div>
  );
}

function ProductForm({
  lenders,
  pending,
  onSubmit,
}: {
  lenders: LenderRow[];
  pending: boolean;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    lenderId: lenders[0]?.id ?? '',
    name: '5-year fixed',
    rateType: 'fixed',
    termYears: '5',
    postedRate: '',
    minCreditScore: '',
    maxLtv: '',
    maxGds: '',
    maxTds: '',
    maxAmortization: '',
  });
  const [flags, setFlags] = useState({
    allowsInsured: true,
    allowsUninsured: true,
    allowsRental: true,
    allowsSelfEmployed: true,
  });

  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="mt-4 rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="p-lender">
            Lender
          </label>
          <select id="p-lender" className="input" value={values.lenderId} onChange={set('lenderId')}>
            {lenders.map((lender) => (
              <option key={lender.id} value={lender.id}>
                {lender.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="p-name">
            Product name
          </label>
          <input id="p-name" className="input" value={values.name} onChange={set('name')} />
        </div>
        <div>
          <label className="label" htmlFor="p-type">
            Rate type
          </label>
          <select id="p-type" className="input" value={values.rateType} onChange={set('rateType')}>
            <option value="fixed">Fixed</option>
            <option value="variable">Variable</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="p-rate">
            Rate (%)
          </label>
          <input
            id="p-rate"
            className="input tabular-nums"
            inputMode="decimal"
            value={values.postedRate}
            onChange={set('postedRate')}
            placeholder="4.79"
          />
        </div>
        <div>
          <label className="label" htmlFor="p-term">
            Term (years)
          </label>
          <input
            id="p-term"
            className="input tabular-nums"
            inputMode="decimal"
            value={values.termYears}
            onChange={set('termYears')}
          />
        </div>
      </div>

      <p className="label mt-4">
        Qualification rules{' '}
        <span className="font-normal text-[var(--color-ink-400)]">
          — leave blank for &ldquo;no constraint&rdquo;. A blank is not zero.
        </span>
      </p>
      <div className="grid gap-3 sm:grid-cols-5">
        {([
          ['minCreditScore', 'Min score'],
          ['maxLtv', 'Max LTV %'],
          ['maxGds', 'Max GDS %'],
          ['maxTds', 'Max TDS %'],
          ['maxAmortization', 'Max amort'],
        ] as const).map(([key, label]) => (
          <div key={key}>
            <label className="label text-[12px]" htmlFor={`p-${key}`}>
              {label}
            </label>
            <input
              id={`p-${key}`}
              className="input tabular-nums"
              inputMode="numeric"
              value={values[key] ?? ''}
              onChange={set(key)}
              placeholder="—"
            />
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-4">
        {([
          ['allowsInsured', 'Takes insured'],
          ['allowsUninsured', 'Takes uninsured'],
          ['allowsRental', 'Takes rentals'],
          ['allowsSelfEmployed', 'Takes self-employed'],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={flags[key]}
              onChange={(event) =>
                setFlags((current) => ({ ...current, [key]: event.target.checked }))
              }
              className="h-4 w-4 accent-[var(--color-accent-700)]"
            />
            {label}
          </label>
        ))}
      </div>

      <button
        type="button"
        className="btn btn-primary mt-4"
        disabled={pending || !values.postedRate || !values.lenderId}
        onClick={() =>
          onSubmit({
            lenderId: values.lenderId,
            name: values.name,
            rateType: values.rateType,
            termYears: Number(values.termYears) || 5,
            postedRate: Number(values.postedRate),
            minCreditScore: values.minCreditScore || null,
            maxLtv: values.maxLtv || null,
            maxGds: values.maxGds || null,
            maxTds: values.maxTds || null,
            maxAmortization: values.maxAmortization || null,
            ...flags,
          })
        }
      >
        {pending ? 'Adding…' : 'Add product'}
      </button>
    </div>
  );
}
