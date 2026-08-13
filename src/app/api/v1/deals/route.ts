/**
 * Public API — deals.
 *
 * Authenticated by API key rather than session cookie, because the callers are
 * Zapier, a CRM, or the brokerage's own scripts. The distinction matters for
 * more than convenience: cookie auth on a machine endpoint invites CSRF, and
 * bearer-token auth on a browser endpoint invites token storage in
 * localStorage. Each surface uses the one that suits it.
 *
 * Runs under the `system` actor. An API key is not a person — it belongs to the
 * brokerage — and `system` is the existing actor that means exactly that. It
 * satisfies `app_is_staff()`, so RLS grants the same visibility a broker has,
 * which is the intended scope for a brokerage's own integration key.
 *
 * The response shape is flat and versioned in the path. An integration built
 * against a nested internal model breaks every time that model moves; this is a
 * contract, and `/v1/` is what lets it change later without breaking callers.
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { asSystem } from '@/db';
import { clients, deals } from '@/db/schema';
import { authenticateApiKey, hasScope } from '@/lib/api/keys';
import { num } from '@/lib/deals/queries';

const MAX_LIMIT = 100;

export async function GET(request: Request) {
  const url = new URL(request.url);

  const caller = await asSystem(async (db) =>
    authenticateApiKey(db, request.headers.get('authorization')),
  );

  if (!caller) {
    return NextResponse.json(
      { error: 'Provide a valid API key as `Authorization: Bearer <key>`.' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  if (!hasScope(caller, 'read')) {
    return NextResponse.json({ error: 'This key does not have read scope.' }, { status: 403 });
  }

  const requested = Number(url.searchParams.get('limit'));
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 25, MAX_LIMIT);

  const stage = url.searchParams.get('stage');
  const status = url.searchParams.get('status');

  const filters: SQL[] = [];
  if (stage) filters.push(eq(deals.stageKey, stage));
  if (status) filters.push(sql`${deals.status}::text = ${status}`);

  const rows = await asSystem(async (db) =>
    db
      .select({
        id: deals.id,
        reference: deals.reference,
        dealType: deals.dealType,
        stageKey: deals.stageKey,
        status: deals.status,
        mortgageAmount: deals.mortgageAmount,
        purchasePrice: deals.purchasePrice,
        propertyCity: deals.propertyCity,
        propertyProvince: deals.propertyProvince,
        maturityDate: deals.maturityDate,
        leadSource: deals.leadSource,
        referralCode: deals.referralCode,
        createdAt: deals.createdAt,
        updatedAt: deals.updatedAt,
        primaryName: clients.fullName,
        primaryEmail: clients.email,
      })
      .from(deals)
      .innerJoin(clients, eq(clients.id, deals.clientId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(deals.updatedAt))
      .limit(limit),
  );

  return NextResponse.json({
    object: 'list',
    count: rows.length,
    has_more: rows.length === limit,
    data: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      deal_type: row.dealType,
      stage: row.stageKey,
      status: row.status,
      mortgage_amount: num(row.mortgageAmount),
      purchase_price: num(row.purchasePrice),
      property: {
        city: row.propertyCity,
        province: row.propertyProvince,
      },
      maturity_date: row.maturityDate,
      lead_source: row.leadSource,
      referral_code: row.referralCode,
      primary_borrower: { name: row.primaryName, email: row.primaryEmail },
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    })),
  });
}
