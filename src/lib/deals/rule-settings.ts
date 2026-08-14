/**
 * Reading and writing the brokerage's validation rule settings.
 *
 * Kept apart from `validation.ts` so that module stays pure and testable. The
 * table holds only the rules that differ from their defaults — an unmodified
 * rule has no row, so a new rule added to the catalogue in a later release
 * arrives at its intended default rather than silently disabled.
 */

import { eq } from 'drizzle-orm';

import type { Db } from '@/db';
import { validationRules } from '@/db/schema';
import { RULES_BY_KEY, type RuleOverride, type Severity } from '@/lib/deals/validation';

export async function loadRuleOverrides(db: Db): Promise<Map<string, RuleOverride>> {
  const rows = await db
    .select({
      ruleKey: validationRules.ruleKey,
      severity: validationRules.severity,
      isActive: validationRules.isActive,
    })
    .from(validationRules);

  const overrides = new Map<string, RuleOverride>();

  for (const row of rows) {
    const rule = RULES_BY_KEY.get(row.ruleKey);
    // A row for a rule this version does not know about is ignored rather than
    // deleted — downgrading the app should not destroy the settings.
    if (!rule || rule.locked) continue;

    overrides.set(row.ruleKey, {
      severity: row.severity === 'warning' ? 'warning' : 'blocking',
      enabled: row.isActive,
    });
  }

  return overrides;
}

export interface RuleSettingInput {
  ruleKey: string;
  severity: Severity;
  enabled: boolean;
}

/**
 * Store one rule's setting.
 *
 * Returns false for a locked or unknown rule rather than throwing, so the
 * caller can report it. A locked rule is refused here as well as in the route:
 * this is the function anything server-side would reach for, and the guarantee
 * should not depend on which door was used.
 */
export async function saveRuleSetting(db: Db, input: RuleSettingInput): Promise<boolean> {
  const rule = RULES_BY_KEY.get(input.ruleKey);
  if (!rule || rule.locked) return false;

  const [existing] = await db
    .select({ id: validationRules.id })
    .from(validationRules)
    .where(eq(validationRules.ruleKey, input.ruleKey))
    .limit(1);

  if (existing) {
    await db
      .update(validationRules)
      .set({ severity: input.severity, isActive: input.enabled })
      .where(eq(validationRules.id, existing.id));
    return true;
  }

  await db.insert(validationRules).values({
    name: rule.label,
    ruleKey: input.ruleKey,
    severity: input.severity,
    isActive: input.enabled,
  });

  return true;
}

/** Drop the row so the rule returns to its shipped default. */
export async function resetRuleSetting(db: Db, ruleKey: string): Promise<boolean> {
  const rule = RULES_BY_KEY.get(ruleKey);
  if (!rule || rule.locked) return false;

  await db.delete(validationRules).where(eq(validationRules.ruleKey, ruleKey));
  return true;
}
