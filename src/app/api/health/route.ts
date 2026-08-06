/**
 * Health and dependency check.
 *
 * Worth hitting once after deployment: it exercises Postgres, Drive and SMTP
 * and names whichever one is misconfigured. Almost every "the portal is
 * broken" report resolves to one of those three.
 *
 * Unauthenticated but deliberately thin — it reports up/down and a short
 * remediation hint, never versions, hostnames or credentials.
 */

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { asSystem } from '@/db';
import { queueDepth } from '@/lib/agent';
import { checkDriveAccess } from '@/lib/drive/service';
import { verifySmtp } from '@/lib/mail/smtp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const verbose = new URL(request.url).searchParams.get('verbose') === '1';

  const database = await asSystem(async (db) => {
    await db.execute(sql`SELECT 1`);
    return { ok: true, detail: 'Connected.' };
  }).catch((error: unknown) => ({
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  }));

  // Only probe third parties when asked — an uptime monitor polling every 30
  // seconds should not be making Drive and SMTP calls.
  const [drive, smtp, queued] = verbose
    ? await Promise.all([
        checkDriveAccess(),
        verifySmtp(),
        asSystem((db) => queueDepth(db)).catch(() => -1),
      ])
    : [null, null, null];

  const checks = { database, ...(verbose ? { drive, smtp, agentQueueDepth: queued } : {}) };
  const healthy = database.ok && (!verbose || (drive?.ok === true && smtp?.ok === true));

  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    { status: healthy ? 200 : 503 },
  );
}
