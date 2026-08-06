import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generatePassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/lib/auth/password';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('same-password', a), true);
    assert.equal(await verifyPassword('same-password', b), true);
  });

  it('never stores the plaintext', async () => {
    const secret = 'a-very-distinctive-plaintext-value';
    const hash = await hashPassword(secret);
    assert.equal(hash.includes(secret), false);
  });

  it('uses the versioned scrypt format', async () => {
    const hash = await hashPassword('x');
    const parts = hash.split('$');
    assert.equal(parts.length, 6);
    assert.equal(parts[0], 'scrypt');
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
    assert.equal(await verifyPassword('x', ''), false);
    assert.equal(await verifyPassword('x', 'bcrypt$1$2$3$4$5'), false);
  });

  it('normalises unicode so equivalent inputs match', async () => {
    // é as one codepoint vs e + combining accent. A client typing on a Mac and
    // on Windows must not get different results.
    const composed = 'passwordé123456';
    const decomposed = 'passwordé123456'.normalize('NFD');
    const hash = await hashPassword(composed);
    assert.equal(await verifyPassword(decomposed, hash), true);
  });

  it('flags weaker legacy hashes for upgrade', async () => {
    assert.equal(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA=='), true);
    assert.equal(needsRehash(await hashPassword('x')), false);
    assert.equal(needsRehash('garbage'), true);
  });
});

describe('generated passwords', () => {
  it('has the requested length', () => {
    assert.equal(generatePassword().length, 16);
    assert.equal(generatePassword(24).length, 24);
  });

  it('excludes characters that are ambiguous when read aloud', () => {
    // 400 samples of 16 chars is ~6400 draws; a banned character would appear
    // with overwhelming probability if the alphabet were wrong.
    const banned = /[0O1lI]/;
    for (let i = 0; i < 400; i += 1) {
      assert.equal(banned.test(generatePassword()), false);
    }
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generatePassword());
    assert.equal(seen.size, 500);
  });
});
