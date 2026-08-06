/**
 * Password hashing and generation.
 *
 * Uses scrypt from node:crypto rather than bcrypt or argon2. Rationale: scrypt
 * is memory-hard, is what the Node docs recommend for password storage, and
 * has zero native dependencies — which matters because this app is built to be
 * portable across hosts and a native build step is the most common cause of
 * "works locally, fails in the container".
 *
 * The stored format is self-describing and versioned:
 *
 *     scrypt$N$r$p$<salt-base64>$<hash-base64>
 *
 * so parameters can be raised later and old hashes upgraded transparently on
 * next successful login without a migration.
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Promise wrapper around scrypt.
 *
 * Hand-written rather than `promisify(scrypt)` because promisify's overload
 * resolution drops the options argument, and options is exactly where the
 * cost parameters live.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * N=2^16 with r=8, p=1 costs roughly 100ms and 64 MB per hash on modern
 * hardware. maxmem must be raised explicitly — Node's 32 MB default rejects
 * these parameters.
 */
const PARAMS = { N: 65536, r: 8, p: 1, keyLength: 64, maxmem: 192 * 1024 * 1024 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification. Returns false rather than throwing on a
 * malformed stored hash so that a corrupted row denies access instead of
 * producing a 500 that leaks which accounts exist.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number.parseInt(parts[1]!, 10);
    const r = Number.parseInt(parts[2]!, 10);
    const p = Number.parseInt(parts[3]!, 10);
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');

    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

    const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });

    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number.parseInt(parts[1]!, 10) < PARAMS.N;
}

/**
 * Alphabet for generated passwords: no 0/O, 1/l/I, or characters that get
 * mangled when read aloud over the phone or copied out of an email client.
 * A client who cannot type their password will phone you, which defeats the
 * point of automating the onboarding.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * Generate a temporary password.
 *
 * 16 characters from a 57-character alphabet is ~93 bits of entropy — far
 * beyond what a credential email needs, and the client is forced to change it
 * on first login anyway (clients.must_change_password).
 *
 * Uses crypto.randomInt, which is rejection-sampled and therefore unbiased;
 * `Math.random()` or `bytes[i] % alphabet.length` would both skew the
 * distribution.
 */
export function generatePassword(length = 16): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}
