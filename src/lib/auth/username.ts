/**
 * Username generation from a client's name.
 *
 * Format: first initial + last name, lowercased and stripped to ASCII letters
 * and digits — "Priya Ramanathan" → "pramanathan". Collisions get a numeric
 * suffix ("pramanathan2"), never a random string: a username a client cannot
 * remember or read back over the phone is a support call.
 */

import type { Db } from '@/db';
import { clients } from '@/db/schema';
import { sql } from 'drizzle-orm';

/**
 * Strip diacritics via NFD decomposition, then drop everything that is not a
 * basic letter or digit. "Zoë O'Brien-Smith" → "zobriensmith".
 *
 * Names in scripts with no Latin representation (Chinese, Arabic, Cyrillic)
 * reduce to an empty string here; `baseUsername` falls back to "client" in
 * that case and the numeric suffix keeps it unique. Those clients get a
 * working login rather than a crash, and you can rename them by hand.
 */
function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function baseUsername(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return 'client';

  if (parts.length === 1) {
    return slugify(parts[0]!).slice(0, 20) || 'client';
  }

  const firstInitial = slugify(parts[0]!).charAt(0);
  const lastName = slugify(parts[parts.length - 1]!);
  const candidate = `${firstInitial}${lastName}`.slice(0, 20);

  return candidate || 'client';
}

/**
 * Find a free username derived from `fullName`.
 *
 * The uniqueness check and the eventual INSERT are not atomic, so the caller
 * must run both inside the same transaction and be prepared for a unique
 * violation on `clients_username_key` under concurrent onboarding. That case
 * is handled with a retry in `createClientProfile`.
 */
export async function allocateUsername(db: Db, fullName: string): Promise<string> {
  const base = baseUsername(fullName);

  const taken = await db
    .select({ username: clients.username })
    .from(clients)
    .where(sql`lower(${clients.username}) = ${base} OR lower(${clients.username}) LIKE ${base + '%'}`);

  const takenSet = new Set(taken.map((row) => row.username.toLowerCase()));

  if (!takenSet.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!takenSet.has(candidate)) return candidate;
  }

  // 998 clients sharing one name is not a real scenario, but returning
  // something unique beats throwing during onboarding.
  return `${base}${Date.now().toString(36)}`;
}
