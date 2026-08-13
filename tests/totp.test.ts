import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  base32Decode,
  base32Encode,
  currentStep,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  normaliseRecoveryCode,
  totpUri,
  verifyTotp,
} from '../src/lib/auth/totp';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const input of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      const buffer = Buffer.from(input);
      assert.equal(base32Decode(base32Encode(buffer)).toString(), input);
    }
  });

  it('matches the RFC 4648 test vectors', () => {
    assert.equal(base32Encode(Buffer.from('f')), 'MY');
    assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
    assert.equal(base32Encode(Buffer.from('foo')), 'MZXW6');
    assert.equal(base32Encode(Buffer.from('foob')), 'MZXW6YQ');
    assert.equal(base32Encode(Buffer.from('fooba')), 'MZXW6YTB');
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  });

  it('tolerates padding, whitespace and lower case on the way in', () => {
    assert.equal(base32Decode('mzxw6ytboi').toString(), 'foobar');
    assert.equal(base32Decode('MZXW 6YTB OI').toString(), 'foobar');
    assert.equal(base32Decode('MZXW6YTBOI======').toString(), 'foobar');
  });

  it('rejects characters outside the alphabet', () => {
    assert.throws(() => base32Decode('MZXW6YTB0I'), /Invalid base32/); // zero, not O
  });
});

describe('TOTP against the RFC 6238 test vectors', () => {
  // The RFC's SHA-1 secret is the ASCII "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  // Published vectors, truncated to 6 digits from the RFC's 8-digit table.
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ];

  for (const [seconds, expected] of vectors) {
    it(`produces ${expected} at t=${seconds}`, () => {
      assert.equal(generateTotp(secret, seconds * 1000), expected);
    });
  }
});

describe('TOTP verification', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  it('accepts the current code', () => {
    const code = generateTotp(secret, now);
    assert.equal(verifyTotp(secret, code, { atMs: now }).valid, true);
  });

  it('tolerates a phone clock one step slow or fast', () => {
    const slow = generateTotp(secret, now - 30_000);
    const fast = generateTotp(secret, now + 30_000);

    assert.equal(verifyTotp(secret, slow, { atMs: now }).valid, true);
    assert.equal(verifyTotp(secret, fast, { atMs: now }).valid, true);
  });

  it('rejects a code two steps away', () => {
    const stale = generateTotp(secret, now - 90_000);
    assert.equal(verifyTotp(secret, stale, { atMs: now }).valid, false);
  });

  it('rejects a replayed code even though the arithmetic checks out', () => {
    const code = generateTotp(secret, now);
    const first = verifyTotp(secret, code, { atMs: now });
    assert.equal(first.valid, true);
    assert.ok(first.step !== null);

    // Same code, same window, but the step has already been spent.
    const replay = verifyTotp(secret, code, { atMs: now, lastUsedStep: first.step });
    assert.equal(replay.valid, false, 'a spent code must not be accepted twice');
  });

  it('still accepts the next window after one is spent', () => {
    const used = verifyTotp(secret, generateTotp(secret, now), { atMs: now });
    const later = now + 30_000;
    const next = verifyTotp(secret, generateTotp(secret, later), {
      atMs: later,
      lastUsedStep: used.step,
    });
    assert.equal(next.valid, true);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '   ']) {
      assert.equal(verifyTotp(secret, bad, { atMs: now }).valid, false);
    }
  });

  it('ignores separators a user might type', () => {
    const code = generateTotp(secret, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    assert.equal(verifyTotp(secret, spaced, { atMs: now }).valid, true);
  });

  it('rejects a code from a different secret', () => {
    const other = generateTotpSecret();
    assert.equal(verifyTotp(secret, generateTotp(other, now), { atMs: now }).valid, false);
  });
});

describe('secrets and the otpauth URI', () => {
  it('generates a 20-byte secret', () => {
    assert.equal(base32Decode(generateTotpSecret()).length, 20);
  });

  it('generates a different secret every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    assert.equal(seen.size, 50);
  });

  it('builds a URI an authenticator app can read', () => {
    const uri = totpUri('JBSWY3DPEHPK3PXP', 'priya@example.ca', 'UWA Mortgage Portal');

    assert.ok(uri.startsWith('otpauth://totp/'));
    assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
    // Issuer both in the label and as a parameter — apps read different ones.
    assert.ok(uri.includes('issuer=UWA'));
    assert.ok(decodeURIComponent(uri).includes('UWA Mortgage Portal:priya@example.ca'));
    assert.ok(uri.includes('digits=6'));
    assert.ok(uri.includes('period=30'));
    // No padding: authenticator apps choke on it.
    assert.ok(!uri.includes('%3D'));
  });

  it('advances the step every 30 seconds', () => {
    assert.equal(currentStep(0), 0);
    assert.equal(currentStep(29_999), 0);
    assert.equal(currentStep(30_000), 1);
    assert.equal(currentStep(59_999), 1);
  });
});

describe('recovery codes', () => {
  it('generates ten distinct codes', () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
  });

  it('avoids characters that are misread aloud or on paper', () => {
    for (const code of generateRecoveryCodes(50)) {
      assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, `ambiguous character in ${code}`);
      assert.ok(!/[01IO]/.test(code));
    }
  });

  it('normalises however the user types it back', () => {
    const code = generateRecoveryCodes(1)[0]!;
    const bare = code.replace('-', '');

    assert.equal(normaliseRecoveryCode(code), bare);
    assert.equal(normaliseRecoveryCode(code.toLowerCase()), bare);
    assert.equal(normaliseRecoveryCode(code.replace('-', ' ')), bare);
    assert.equal(normaliseRecoveryCode(`  ${code}  `), bare);
  });
});
