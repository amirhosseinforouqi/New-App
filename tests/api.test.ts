import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signPayload, verifySignature, WEBHOOK_EVENTS } from '../src/lib/api/webhooks';

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret_value';
  const body = JSON.stringify({ event: 'deal.funded', data: { reference: 'UWA-2026-0001' } });
  const now = 1_800_000_000;

  it('verifies a signature it produced', () => {
    const header = signPayload(secret, body, now);
    assert.equal(verifySignature(secret, body, header, 300, now), true);
  });

  it('uses the documented t=,v1= shape', () => {
    const header = signPayload(secret, body, now);
    assert.match(header, /^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('rejects a tampered body', () => {
    const header = signPayload(secret, body, now);
    const tampered = body.replace('UWA-2026-0001', 'UWA-2026-9999');
    assert.equal(verifySignature(secret, tampered, header, 300, now), false);
  });

  it('rejects the wrong secret', () => {
    const header = signPayload(secret, body, now);
    assert.equal(verifySignature('whsec_someone_else', body, header, 300, now), false);
  });

  it('rejects a replayed delivery once the tolerance passes', () => {
    // The timestamp is inside the signed payload, so an old capture cannot be
    // re-presented with a fresh timestamp — this is the property that makes
    // signing `{t}.{body}` rather than `body` alone worth doing.
    const header = signPayload(secret, body, now);

    assert.equal(verifySignature(secret, body, header, 300, now + 299), true);
    assert.equal(verifySignature(secret, body, header, 300, now + 301), false);
  });

  it('rejects a timestamp from the future beyond tolerance', () => {
    const header = signPayload(secret, body, now + 10_000);
    assert.equal(verifySignature(secret, body, header, 300, now), false);
  });

  it('rejects a signature whose timestamp has been swapped', () => {
    const header = signPayload(secret, body, now);
    const swapped = header.replace(`t=${now}`, `t=${now + 60}`);
    assert.equal(verifySignature(secret, body, swapped, 300, now + 60), false);
  });

  it('rejects malformed headers without throwing', () => {
    for (const header of ['', 'garbage', 't=abc,v1=def', 'v1=only', `t=${now}`]) {
      assert.doesNotThrow(() => verifySignature(secret, body, header, 300, now));
      assert.equal(verifySignature(secret, body, header, 300, now), false);
    }
  });

  it('produces a different signature for a different timestamp', () => {
    assert.notEqual(signPayload(secret, body, now), signPayload(secret, body, now + 1));
  });
});

describe('webhook event catalogue', () => {
  it('is unique and namespaced', () => {
    assert.equal(new Set(WEBHOOK_EVENTS).size, WEBHOOK_EVENTS.length);
    for (const event of WEBHOOK_EVENTS) {
      assert.match(event, /^[a-z_]+\.[a-z_]+$/, `${event} should be object.verb`);
    }
  });

  it('covers the moments an integration actually cares about', () => {
    for (const required of ['application.submitted', 'deal.stage_changed', 'deal.funded']) {
      assert.ok(
        (WEBHOOK_EVENTS as readonly string[]).includes(required),
        `missing ${required}`,
      );
    }
  });
});
