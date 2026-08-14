import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canRequest,
  CONNECTION_KINDS,
  CONNECTION_KINDS_BY_KEY,
  summariseConnections,
  type ConnectionRecord,
} from '../src/lib/deals/connections';

const record = (overrides: Partial<ConnectionRecord>): ConnectionRecord => ({
  id: 'r1',
  clientId: 'c1',
  kind: 'bank_statements',
  provider: 'manual',
  status: 'requested',
  detail: null,
  requestedAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: null,
  ...overrides,
});

describe('connection catalogue', () => {
  it('has a unique key per kind', () => {
    const keys = CONNECTION_KINDS.map((kind) => kind.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(CONNECTION_KINDS_BY_KEY.size, CONNECTION_KINDS.length);
  });

  it('gives every kind a manual route, because none of them are automated here', () => {
    for (const kind of CONNECTION_KINDS) {
      assert.ok(kind.manualRoute.length > 0, `${kind.key} has no manual route`);
    }
  });

  it('marks CRA as having nothing to buy', () => {
    // There is no public CRA API for a brokerage, so claiming a vendor route
    // would be inventing one.
    assert.equal(CONNECTION_KINDS_BY_KEY.get('cra_assessment')!.vendorRoute, null);
  });

  it('gates the two that touch a borrower’s own accounts on consent', () => {
    assert.equal(CONNECTION_KINDS_BY_KEY.get('bank_statements')!.requiresConsent, true);
    assert.equal(CONNECTION_KINDS_BY_KEY.get('credit_bureau')!.requiresConsent, true);
    assert.equal(CONNECTION_KINDS_BY_KEY.get('cra_assessment')!.requiresConsent, false);
  });
});

describe('summarising connections', () => {
  it('lists every borrower even with no records at all', () => {
    const summary = summariseConnections([], ['c1', 'c2']);

    const bank = summary.find((entry) => entry.kind.key === 'bank_statements')!;
    assert.deepEqual([...bank.byClient.keys()], ['c1', 'c2']);
    assert.deepEqual(bank.outstandingFor, ['c1', 'c2']);
  });

  it('clears a borrower once something is received', () => {
    const summary = summariseConnections(
      [record({ clientId: 'c1', status: 'received' })],
      ['c1', 'c2'],
    );

    const bank = summary.find((entry) => entry.kind.key === 'bank_statements')!;
    assert.deepEqual(bank.outstandingFor, ['c2']);
  });

  it('counts a declined request as still outstanding', () => {
    // A decline is information, not completion — the file still lacks the
    // document, and treating it as done would hide that.
    const summary = summariseConnections(
      [record({ clientId: 'c1', status: 'declined' })],
      ['c1'],
    );

    const bank = summary.find((entry) => entry.kind.key === 'bank_statements')!;
    assert.deepEqual(bank.outstandingFor, ['c1']);
  });

  it('counts a request that has not come back as outstanding', () => {
    const summary = summariseConnections(
      [record({ clientId: 'c1', status: 'requested' })],
      ['c1'],
    );

    assert.deepEqual(
      summary.find((entry) => entry.kind.key === 'bank_statements')!.outstandingFor,
      ['c1'],
    );
  });

  it('orders a borrower’s history newest first', () => {
    const summary = summariseConnections(
      [
        record({ id: 'old', requestedAt: new Date('2026-01-01T00:00:00Z') }),
        record({ id: 'new', requestedAt: new Date('2026-03-01T00:00:00Z') }),
        record({ id: 'mid', requestedAt: new Date('2026-02-01T00:00:00Z') }),
      ],
      ['c1'],
    );

    const bank = summary.find((entry) => entry.kind.key === 'bank_statements')!;
    assert.deepEqual(
      bank.byClient.get('c1')!.map((entry) => entry.id),
      ['new', 'mid', 'old'],
    );
  });

  it('keeps one kind’s records out of another’s', () => {
    const summary = summariseConnections(
      [record({ kind: 'credit_bureau', status: 'received' })],
      ['c1'],
    );

    assert.deepEqual(
      summary.find((entry) => entry.kind.key === 'credit_bureau')!.outstandingFor,
      [],
    );
    assert.deepEqual(
      summary.find((entry) => entry.kind.key === 'bank_statements')!.outstandingFor,
      ['c1'],
    );
  });
});

describe('consent gate', () => {
  it('refuses a bureau pull without a signed consent', () => {
    const gate = canRequest(CONNECTION_KINDS_BY_KEY.get('credit_bureau')!, false);

    assert.equal(gate.allowed, false);
    assert.ok(gate.reason);
  });

  it('allows it once signed', () => {
    const gate = canRequest(CONNECTION_KINDS_BY_KEY.get('credit_bureau')!, true);

    assert.equal(gate.allowed, true);
    assert.equal(gate.reason, null);
  });

  it('does not gate a kind that needs no consent', () => {
    const gate = canRequest(CONNECTION_KINDS_BY_KEY.get('cra_assessment')!, false);

    assert.equal(gate.allowed, true);
  });
});
