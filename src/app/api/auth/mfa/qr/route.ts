/**
 * QR code for an otpauth URI, rendered server-side as SVG.
 *
 * Server-side because the Content-Security-Policy forbids external images, so
 * the usual trick of pointing an <img> at a public QR service silently renders
 * nothing — and pointing a mortgage portal's 2FA secret at a third-party image
 * host would be a poor idea regardless.
 *
 * The URI is rebuilt here from the caller's own stored secret rather than being
 * echoed back from the query string. Rendering an arbitrary attacker-supplied
 * string into a QR code the user is told to scan is a phishing primitive: it
 * would let someone hand a victim a link that enrols the victim's authenticator
 * against an account the attacker controls.
 */

import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { eq } from 'drizzle-orm';

import { asSystem } from '@/db';
import { brokers, clients } from '@/db/schema';
import { getCurrentUser } from '@/lib/auth/session';
import { totpUri } from '@/lib/auth/totp';
import { env } from '@/lib/env';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  if (!user.mfaSatisfied) {
    return NextResponse.json({ error: 'Finish verifying first.' }, { status: 403 });
  }

  const secret = await asSystem(async (db) => {
    if (user.kind === 'client') {
      const [row] = await db
        .select({ secret: clients.totpSecret, enabled: clients.totpEnabled })
        .from(clients)
        .where(eq(clients.id, user.id))
        .limit(1);
      return row;
    }

    const [row] = await db
      .select({ secret: brokers.totpSecret, enabled: brokers.totpEnabled })
      .from(brokers)
      .where(eq(brokers.id, user.id))
      .limit(1);
    return row;
  });

  // Only during enrolment. Once 2FA is confirmed the secret is never re-served
  // — there is no legitimate reason to display it again, and every reason not
  // to make it retrievable from a session someone might have hijacked.
  if (!secret?.secret || secret.enabled) {
    return NextResponse.json({ error: 'No enrolment in progress.' }, { status: 400 });
  }

  const label = user.kind === 'client' ? user.username : user.email;
  const uri = totpUri(secret.secret, label, env.appName);

  const svg = await QRCode.toString(uri, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#12161f', light: '#ffffff' },
  });

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      // Never cached: it carries a secret.
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
