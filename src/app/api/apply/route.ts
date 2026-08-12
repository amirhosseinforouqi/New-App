/**
 * Public intake submission.
 *
 * This is the only unauthenticated write endpoint in the application, which
 * makes it the one worth being careful about:
 *
 *   - The answer bag is capped in size and in key count before it is parsed,
 *     so a submission cannot be used to write an unbounded blob into jsonb.
 *   - Required fields are re-validated server-side against the same tier
 *     definition the browser used. The browser's validation is a convenience;
 *     this one is the rule.
 *   - Submissions are rate-limited per IP. In-process, because that is honest
 *     about what a single-container deployment can enforce — behind more than
 *     one instance this belongs in a shared store, and the comment in
 *     `tooManyAttempts` says so.
 *
 * Nothing here confirms whether an email address already has an account. A
 * returning borrower and a new one get the same response, because the
 * difference is an account-enumeration oracle.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { validateSubmission } from '@/lib/intake/mapping';
import { submitIntake } from '@/lib/intake/submit';

const MAX_ANSWER_KEYS = 80;
const MAX_ANSWER_LENGTH = 4_000;

const answerValue = z.union([
  z.string().max(MAX_ANSWER_LENGTH),
  z.number(),
  z.boolean(),
]);

const bodySchema = z.object({
  tier: z.enum(['ez', 'short', 'long']),
  locale: z.enum(['en', 'fr']),
  referralCode: z.string().trim().max(64).optional(),
  answers: z.record(z.string().max(64), answerValue).refine(
    (value) => Object.keys(value).length <= MAX_ANSWER_KEYS,
    `An application cannot contain more than ${MAX_ANSWER_KEYS} answers.`,
  ),
});

/**
 * Per-IP submission limit.
 *
 * In-process and therefore per-instance: this stops a bored script, not a
 * distributed flood. Behind a load balancer with more than one container, move
 * the counter to Redis or Postgres — the shape of the check does not change.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const record = attempts.get(ip);

  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });

    // Opportunistic sweep so the map cannot grow without bound.
    if (attempts.size > 5_000) {
      for (const [key, value] of attempts) {
        if (now > value.resetAt) attempts.delete(key);
      }
    }

    return false;
  }

  record.count += 1;
  return record.count > MAX_PER_WINDOW;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

export async function POST(request: Request) {
  const ip = clientIp(request);

  if (tooManyAttempts(ip)) {
    return NextResponse.json(
      { error: 'Too many applications from this connection. Please try again later.' },
      { status: 429 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'That application could not be read.' },
      { status: 400 },
    );
  }

  const { tier, locale, answers, referralCode } = parsed.data;

  const missing = validateSubmission(tier, answers);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Some required questions are still unanswered.', missing },
      { status: 400 },
    );
  }

  try {
    const result = await submitIntake({
      tier,
      locale,
      answers,
      referralCode: referralCode ?? null,
      ipAddress: ip === 'unknown' ? null : ip,
      userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
    });

    return NextResponse.json({
      reference: result.dealReference,
      emailSent: result.emailSent,
      coBorrowerInvited: result.coBorrowerInvited,
      warnings: result.warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[apply] submission failed', { ip, message });

    return NextResponse.json(
      { error: 'We could not save your application. Please try again, or email us directly.' },
      { status: 500 },
    );
  }
}
