/**
 * Which deal does a client's action belong to?
 *
 * Uploads and messages arrive without a deal id — the borrower is just using
 * their dashboard. On a single-deal file that is unambiguous. On a multi-deal
 * file it matters a great deal: a document uploaded for a refinance must not
 * appear on the purchase, and a message about one must not be filed against
 * the other.
 *
 * Resolution order, most specific first:
 *
 *   1. An explicit dealId the caller supplied — validated against membership,
 *      so it cannot be used to write into someone else's file.
 *   2. The client's only active deal, if they have exactly one.
 *   3. Their most recently updated active deal.
 *   4. null, for a client created before deals existed.
 *
 * Returning null rather than guessing wildly is deliberate: a null deal_id is
 * visible and fixable, whereas a document silently attached to the wrong file
 * is the kind of error nobody notices until an underwriter does.
 */

import { and, desc, eq } from 'drizzle-orm';

import type { Db } from '@/db';
import { dealBorrowers, deals } from '@/db/schema';

export async function resolveDealForClient(
  db: Db,
  clientId: string,
  requestedDealId?: string | null,
): Promise<string | null> {
  if (requestedDealId) {
    const [membership] = await db
      .select({ dealId: dealBorrowers.dealId })
      .from(dealBorrowers)
      .where(
        and(eq(dealBorrowers.dealId, requestedDealId), eq(dealBorrowers.clientId, clientId)),
      )
      .limit(1);

    // Not a borrower on it — fall through rather than trusting the input.
    if (membership) return membership.dealId;
  }

  const [mostRecent] = await db
    .select({ id: deals.id })
    .from(dealBorrowers)
    .innerJoin(deals, eq(deals.id, dealBorrowers.dealId))
    .where(and(eq(dealBorrowers.clientId, clientId), eq(deals.status, 'active')))
    .orderBy(desc(deals.updatedAt))
    .limit(1);

  return mostRecent?.id ?? null;
}
