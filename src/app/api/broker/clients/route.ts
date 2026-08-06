/**
 * Create a client manually.
 *
 * Same path as the inbound-email flow — one implementation, one set of
 * behaviours. A client created here gets a Drive folder, a generated
 * checklist and a credentials email exactly as one created from an enquiry.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createClientProfile } from '@/lib/onboarding';
import { getCurrentUser } from '@/lib/auth/session';

const bodySchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  fullName: z.string().trim().min(1, 'Enter the client’s name.').max(200),
  applicationType: z
    .enum(['purchase', 'refinance', 'renewal', 'construction', 'heloc', 'commercial'])
    .default('purchase'),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid details.' },
      { status: 400 },
    );
  }

  const result = await createClientProfile(
    { ...parsed.data, brokerId: user.id, source: 'broker' },
    user.fullName,
  );

  if (!result.created) {
    return NextResponse.json(
      { error: 'A client with that email address already exists.' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    clientId: result.clientId,
    username: result.username,
    emailSent: result.emailSent,
    warnings: result.warnings,
  });
}
