/**
 * Time-based one-time passwords (RFC 6238), and recovery codes.
 *
 * Hand-written against the RFC rather than pulled from a package, for the same
 * reason the password hashing is: this is ~80 lines of well-specified
 * arithmetic on top of node:crypto, and a dependency here is a supply-chain
 * surface sitting directly on the authentication path. There is nothing to
 * invent — the algorithm is HMAC-SHA1 over a counter, truncated.
 *
 * Two details that are easy to get wrong and are the usual source of "the app
 * shows a code but the server rejects it":
 *
 *   Base32 must be RFC 4648 with the standard alphabet and no padding in the
 *   otpauth URI. Authenticator apps are unforgiving about this.
 *
 *   Verification must accept the adjacent time steps. Phone clocks drift, and
 *   a user who types the last digit as the window rolls is not an attacker.
 *   One step either side (±30s) is the conventional tolerance.
 *
 * Replay is prevented above this module, by recording the last accepted step
 * against the account — a code stays valid for its whole 30-second window, so
 * without that an intercepted code is reusable inside it.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 4648 base32, no padding. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`Invalid base32 character: ${character}`);

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** 20 bytes — the RFC 4226 recommended secret length for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The current time step. Exposed so callers can store it for replay defence. */
export function currentStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

function hotp(secret: Buffer, counter: number): string {
  // Counter is a 64-bit big-endian integer. Written as two 32-bit halves
  // because a JS number cannot hold 64 bits precisely, and BigInt here would
  // be needless ceremony for a value that will not exceed 2^53 until the year
  // ~285 million.
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(buffer).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function generateTotp(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), currentStep(atMs));
}

export interface TotpVerification {
  valid: boolean;
  /** The step the code matched. Store it; reject anything <= it next time. */
  step: number | null;
}

/**
 * Verify a code, tolerating one step of clock drift either side.
 *
 * `lastUsedStep` is the replay guard: pass the step previously accepted for
 * this account and a code from that step or earlier is refused even though the
 * arithmetic checks out.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  options: { atMs?: number; window?: number; lastUsedStep?: number | null } = {},
): TotpVerification {
  const candidate = token.replace(/\D/g, '');
  if (candidate.length !== DIGITS) return { valid: false, step: null };

  const secret = base32Decode(secretBase32);
  const now = currentStep(options.atMs ?? Date.now());
  const window = options.window ?? 1;

  for (let offset = -window; offset <= window; offset += 1) {
    const step = now + offset;
    if (step < 0) continue;

    const expected = hotp(secret, step);

    // Constant-time compare. Both are fixed-length numeric strings, so the
    // lengths always match and Buffer.from is safe here.
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (options.lastUsedStep != null && step <= options.lastUsedStep) {
        // Correct code, already spent. This is the replay case.
        return { valid: false, step: null };
      }
      return { valid: true, step };
    }
  }

  return { valid: false, step: null };
}

/**
 * The otpauth:// URI an authenticator app scans.
 *
 * The issuer appears twice by convention — once as a label prefix and once as
 * a parameter — because different apps read different ones, and getting it
 * wrong means every account in the user's app is called "Unknown".
 */
export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes, for the phone that ended up in a lake.
 *
 * Ten codes, each 10 characters from an unambiguous alphabet, formatted in two
 * groups so they can be read aloud over the phone. Stored hashed — they are
 * passwords, and a recovery code table you can read is an authentication
 * bypass.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];

  for (let i = 0; i < count; i += 1) {
    let code = '';
    for (let j = 0; j < 10; j += 1) {
      code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }

  return codes;
}

/** Normalised so "abcde-fghij", "ABCDE FGHIJ" and "ABCDEFGHIJ" all match. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
