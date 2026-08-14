/**
 * Audit trail.
 *
 * Mortgage files attract disputes and, occasionally, regulator questions.
 * "Who advanced this client to Final Approval, and when" needs an answer that
 * does not depend on someone remembering.
 *
 * Writes are best-effort: a failure to log must never fail the action being
 * logged. The `audit_insert_any` RLS policy permits inserts from any actor,
 * while reads are staff-only.
 */

import type { Db } from '@/db';
import { auditLog } from '@/db/schema';

export type AuditAction =
  | 'client.created'
  | 'client.credentials_sent'
  | 'client.login'
  | 'client.login_failed'
  | 'client.password_changed'
  | 'client.suspended'
  | 'client.reactivated'
  | 'stage.advanced'
  | 'application.submitted'
  | 'mfa.enabled'
  | 'mfa.disabled'
  | 'mfa.challenge_failed'
  | 'mfa.recovery_code_used'
  | 'mfa.recovery_codes_regenerated'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'webhook.created'
  | 'webhook.deleted'
  | 'consent.signed'
  | 'compliance.updated'
  | 'identity.verified'
  | 'deal.copied'
  | 'deal.submitted'
  | 'team.invited'
  | 'team.updated'
  | 'commission.recorded'
  | 'deals.imported'
  | 'lender_product.changed'
  | 'deal.submission_exported'
  | 'scenario.saved'
  | 'scenario.deleted'
  | 'validation_rule.changed'
  | 'connection.recorded'
  | 'deal.assigned'
  | 'deal.locked'
  | 'deal.unlocked'
  | 'deal.archived'
  | 'deal.restored'
  | 'document.uploaded'
  | 'document.reviewed'
  | 'document.deleted'
  | 'document.downloaded'
  | 'request.created'
  | 'message.sent'
  | 'agent.run_queued'
  | 'agent.run_completed'
  | 'agent.run_failed'
  | 'broker.login'
  | 'broker.login_failed';

export interface AuditEntry {
  actorType: 'client' | 'broker' | 'agent' | 'system';
  actorId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string | null;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      clientId: entry.clientId ?? null,
      metadata: entry.metadata ?? {},
      ipAddress: entry.ipAddress ?? null,
    });
  } catch (error) {
    console.error('[audit] failed to record entry', {
      action: entry.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
