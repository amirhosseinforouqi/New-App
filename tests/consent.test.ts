import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONSENT_DOCUMENTS,
  hashConsentDocument,
  renderConsent,
  requiredConsentKinds,
  signatureLooksLikeName,
} from '../src/lib/compliance/consent';

describe('consent documents', () => {
  it('substitutes the brokerage name everywhere', () => {
    for (const kind of Object.keys(CONSENT_DOCUMENTS) as Array<keyof typeof CONSENT_DOCUMENTS>) {
      const rendered = renderConsent(kind, 'Foroughi Mortgage Group');
      assert.ok(!rendered.body.includes('{{brokerage}}'), `${kind} left a placeholder`);
    }
  });

  it('marks the credit pull and privacy notice as required', () => {
    const required = requiredConsentKinds();
    assert.ok(required.includes('credit_pull'));
    assert.ok(required.includes('privacy'));
    // The insurance offer must not block a file.
    assert.ok(!required.includes('mpp_offer'));
  });

  it('tells the borrower the things they would otherwise find out too late', () => {
    const mpp = renderConsent('mpp_offer', 'X').body;
    // Creditor insurance is genuinely worse than term life for most people;
    // an offer that omits that is not an informed decision.
    assert.match(mpp, /decreases as your mortgage balance falls/i);
    assert.match(mpp, /term life insurance is often cheaper/i);
    assert.match(mpp, /optional/i);

    const credit = renderConsent('credit_pull', 'X').body;
    assert.match(credit, /withdraw this consent/i);
    assert.match(credit, /single event/i);

    const privacy = renderConsent('privacy', 'X').body;
    assert.match(privacy, /stored in Canada/i);
    assert.match(privacy, /does not decide whether you are approved/i);
  });
});

describe('consent hashing', () => {
  const document = renderConsent('credit_pull', 'Foroughi Mortgage Group');

  it('is stable for identical input', () => {
    assert.equal(hashConsentDocument(document), hashConsentDocument({ ...document }));
  });

  it('changes when a single character of the body changes', () => {
    const tampered = { ...document, body: document.body.replace('permission', 'permision') };
    assert.notEqual(hashConsentDocument(document), hashConsentDocument(tampered));
  });

  it('changes when the version or title changes', () => {
    assert.notEqual(
      hashConsentDocument(document),
      hashConsentDocument({ ...document, version: '1.1' }),
    );
    assert.notEqual(
      hashConsentDocument(document),
      hashConsentDocument({ ...document, title: 'Something else' }),
    );
  });

  it('differs between brokerages, because the text differs', () => {
    const other = renderConsent('credit_pull', 'Another Brokerage');
    assert.notEqual(hashConsentDocument(document), hashConsentDocument(other));
  });

  it('survives a CRLF round trip', () => {
    // A document that changed hash because it passed through an editor would
    // invalidate consents that are perfectly valid.
    const windowsLineEndings = { ...document, body: document.body.replace(/\n/g, '\r\n') };
    assert.equal(hashConsentDocument(document), hashConsentDocument(windowsLineEndings));
  });

  it('produces a 64-character hex digest', () => {
    assert.match(hashConsentDocument(document), /^[a-f0-9]{64}$/);
  });
});

describe('signature name check', () => {
  it('accepts the obvious cases', () => {
    assert.ok(signatureLooksLikeName('Priya Ramanathan', 'Priya Ramanathan'));
    assert.ok(signatureLooksLikeName('priya ramanathan', 'Priya Ramanathan'));
    assert.ok(signatureLooksLikeName('  Priya  Ramanathan ', 'Priya Ramanathan'));
  });

  it('accepts the human ones — this warns, it does not gate', () => {
    // Refusing any of these would be both wrong and insulting.
    assert.ok(signatureLooksLikeName('Liz Chen', 'Elizabeth Chen'), 'shortened first name');
    assert.ok(signatureLooksLikeName('Priya', 'Priya Ramanathan'), 'first name only');
    assert.ok(signatureLooksLikeName('Ramanathan', 'Priya Ramanathan'), 'surname only');
    assert.ok(signatureLooksLikeName('Elise Tremblay', 'Élise Tremblay-Nguyen'), 'accents dropped');
    assert.ok(signatureLooksLikeName('P. Ramanathan', 'Priya Ramanathan'), 'initial');
    assert.ok(signatureLooksLikeName('Marc Nguyen-Tremblay', 'Marc Nguyen'), 'married name');
  });

  it('flags a signature bearing no relation to the name on file', () => {
    assert.ok(!signatureLooksLikeName('Bob Smith', 'Priya Ramanathan'));
    assert.ok(!signatureLooksLikeName('asdf', 'Priya Ramanathan'));
    assert.ok(!signatureLooksLikeName('', 'Priya Ramanathan'));
    assert.ok(!signatureLooksLikeName('   ', 'Priya Ramanathan'));
  });

  it('does not throw on unusual input', () => {
    assert.doesNotThrow(() => signatureLooksLikeName('王小明', 'Xiaoming Wang'));
    assert.doesNotThrow(() => signatureLooksLikeName('123', 'Priya Ramanathan'));
  });
});
