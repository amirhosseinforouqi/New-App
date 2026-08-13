'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface TeamMemberView {
  id: string;
  fullName: string;
  email: string;
  role: string;
  isActive: boolean;
  commissionSplitPercent: number;
  lastLoginAt: string | null;
  inviteAcceptedAt: string | null;
  activeDeals: number;
  fundedDeals: number;
  fundedVolume: number;
}

const ROLES = [
  { value: 'owner', label: 'Owner', detail: 'Everything, including payroll and integrations' },
  { value: 'agent', label: 'Agent', detail: 'Their own deals and clients' },
  { value: 'assistant', label: 'Assistant', detail: 'Documents and communication, no commissions' },
  { value: 'compliance', label: 'Compliance', detail: 'Every file, for review' },
];

const money = (value: number) =>
  value.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

export function TeamPanel({
  team,
  isOwner,
  currentBrokerId,
  appUrl,
}: {
  team: TeamMemberView[];
  isOwner: boolean;
  currentBrokerId: string;
  appUrl: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('agent');
  const [split, setSplit] = useState('70');

  const [refCode, setRefCode] = useState('');
  const [refLabel, setRefLabel] = useState('');

  async function post(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/broker/team', {
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
      setPending(false);
    }
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Team</h2>
        {isOwner && (
          <button
            type="button"
            className="btn btn-secondary px-3 py-1.5 text-[13px]"
            onClick={() => setInviting((current) => !current)}
          >
            {inviting ? 'Cancel' : 'Invite someone'}
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error mt-3" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="alert alert-warn mt-3">{notice}</div>}

      {inviting && (
        <div className="mt-4 rounded-[var(--radius-control)] bg-[var(--color-canvas)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="invite-name">
                Full name
              </label>
              <input
                id="invite-name"
                className="input"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="invite-email">
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                className="input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="invite-role">
                Role
              </label>
              <select
                id="invite-role"
                className="input"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {ROLES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} — {option.detail}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="invite-split">
                Commission split (%)
              </label>
              <input
                id="invite-split"
                className="input tabular-nums"
                inputMode="decimal"
                value={split}
                onChange={(event) => setSplit(event.target.value)}
              />
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary mt-3"
            disabled={pending || !email || !fullName}
            onClick={async () => {
              const data = await post({
                action: 'invite',
                fullName,
                email,
                role,
                commissionSplitPercent: Number(split) || 70,
              });
              if (data) {
                setInviting(false);
                setFullName('');
                setEmail('');
                if (data.temporaryPassword) {
                  setNotice(
                    `${data.warning} Password: ${data.temporaryPassword}`,
                  );
                }
              }
            }}
          >
            {pending ? 'Inviting…' : 'Send invitation'}
          </button>
          <p className="field-hint">
            They get a generated password by email and must change it on first sign-in.
          </p>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-[13px]">
          <thead>
            <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-500)]">
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Role</th>
              <th className="py-2 text-right font-medium">Active</th>
              <th className="py-2 text-right font-medium">Funded</th>
              <th className="py-2 text-right font-medium">Volume</th>
              {isOwner && <th className="py-2 text-right font-medium">Split</th>}
            </tr>
          </thead>
          <tbody>
            {team.map((member) => (
              <tr key={member.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="py-2">
                  <span className="font-medium">
                    {member.fullName}
                    {member.id === currentBrokerId && (
                      <span className="ml-1.5 text-[12px] font-normal text-[var(--color-ink-400)]">
                        (you)
                      </span>
                    )}
                  </span>
                  <span className="block text-[12px] text-[var(--color-ink-400)]">
                    {member.email}
                    {!member.lastLoginAt && ' · never signed in'}
                    {!member.isActive && ' · deactivated'}
                  </span>
                </td>
                <td className="py-2">
                  {isOwner && member.id !== currentBrokerId ? (
                    <select
                      className="input py-1 text-[13px]"
                      value={member.role}
                      disabled={pending}
                      onChange={(event) =>
                        void post({
                          action: 'update_member',
                          brokerId: member.id,
                          role: event.target.value,
                        })
                      }
                      aria-label={`Role for ${member.fullName}`}
                    >
                      {ROLES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="capitalize">{member.role}</span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums">{member.activeDeals}</td>
                <td className="py-2 text-right tabular-nums">{member.fundedDeals}</td>
                <td className="py-2 text-right tabular-nums">{money(member.fundedVolume)}</td>
                {isOwner && (
                  <td className="py-2 text-right tabular-nums">
                    {member.commissionSplitPercent}%
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Referral links ─────────────────────────────────────────────── */}
      {isOwner && (
        <div className="mt-6 border-t border-[var(--color-line)] pt-5">
          <h3 className="text-sm font-semibold">Referral links</h3>
          <p className="mt-0.5 text-[13px] text-[var(--color-ink-500)]">
            Give a realtor or partner their own link. Every deal that arrives through it is
            attributed to them in the table above.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[140px] flex-1">
              <label className="label" htmlFor="ref-code">
                Code
              </label>
              <input
                id="ref-code"
                className="input font-mono"
                value={refCode}
                placeholder="REALTOR-JB"
                onChange={(event) => setRefCode(event.target.value.toUpperCase())}
              />
            </div>
            <div className="min-w-[180px] flex-[2]">
              <label className="label" htmlFor="ref-label">
                Who it is for
              </label>
              <input
                id="ref-label"
                className="input"
                value={refLabel}
                placeholder="Jamie Bell, Bell Realty"
                onChange={(event) => setRefLabel(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || refCode.length < 2 || refLabel.trim() === ''}
              onClick={async () => {
                const data = await post({
                  action: 'create_referral_code',
                  code: refCode,
                  label: refLabel,
                });
                if (data) {
                  setNotice(`Share this: ${appUrl}/apply?ref=${data.code}`);
                  setRefCode('');
                  setRefLabel('');
                }
              }}
            >
              Create
            </button>
          </div>
          <p className="field-hint">
            The link is <span className="font-mono">{appUrl}/apply?ref=CODE</span>. Add{' '}
            <span className="font-mono">&amp;lang=fr</span> for a French-speaking partner.
          </p>
        </div>
      )}
    </section>
  );
}
