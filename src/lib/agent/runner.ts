/**
 * Skill execution and the trigger dispatcher.
 *
 * Two entry points:
 *
 *   queueSkill()   — records a queued run and returns immediately. Used from
 *                    request paths so a client's upload is not held open while
 *                    a model call runs.
 *   runQueuedRun() — executes a queued run. Called by the agent worker.
 *
 * `dispatchTrigger()` is the seam the rest of the app uses: emit an event and
 * every skill registered for it gets queued. Portal code never names a skill.
 */

import { and, asc, eq, sql } from 'drizzle-orm';

import { asAgent, type Db } from '@/db';
import { agentRuns } from '@/db/schema';
import { anthropicConfig } from '@/lib/env';
import { getAnthropic } from './anthropic';
import { getSkill, skillsForTrigger } from './registry';
import type { SkillContext, SkillTrigger } from './types';

export interface QueueOptions {
  clientId: string | null;
  skillKey: string;
  trigger: SkillTrigger;
  input: Record<string, unknown>;
}

/** Record a run as queued. Returns its id. */
export async function queueSkill(db: Db, options: QueueOptions): Promise<string> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      clientId: options.clientId,
      skillKey: options.skillKey,
      trigger: options.trigger,
      status: 'queued',
      input: options.input,
    })
    .returning({ id: agentRuns.id });

  if (!row) throw new Error('Failed to queue agent run.');
  return row.id;
}

/**
 * Fire a trigger: queue every skill registered for it.
 *
 * Returns the queued run ids. Failures to queue are logged, not thrown — a
 * skill registry problem must not break a client's upload.
 */
export async function dispatchTrigger(
  db: Db,
  trigger: SkillTrigger,
  context: { clientId: string | null; input: Record<string, unknown> },
): Promise<string[]> {
  const skills = skillsForTrigger(trigger);
  const ids: string[] = [];

  for (const skill of skills) {
    try {
      ids.push(
        await queueSkill(db, {
          clientId: context.clientId,
          skillKey: skill.key,
          trigger,
          input: context.input,
        }),
      );
    } catch (error) {
      console.error('[agent] failed to queue skill', {
        skill: skill.key,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return ids;
}

/**
 * Claim the oldest queued run.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes it safe to run more than one worker:
 * two workers polling simultaneously each get a different row instead of both
 * grabbing the same one.
 */
export async function claimNextRun(db: Db): Promise<{ id: string } | null> {
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE agent_runs
       SET status = 'running', started_at = now()
     WHERE id = (
       SELECT id FROM agent_runs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id
  `);

  const row = claimed.rows[0];
  return row ? { id: row.id } : null;
}

export interface RunResult {
  status: 'succeeded' | 'failed';
  output?: unknown;
  error?: string;
}

/**
 * Execute one run to completion and persist the outcome.
 *
 * Runs under the `agent` actor, which RLS grants staff-level access — skills
 * legitimately need to read across a client's whole file. They are never
 * given a client-scoped handle.
 */
export async function executeRun(runId: string): Promise<RunResult> {
  const config = anthropicConfig();
  const startedAt = Date.now();

  return asAgent(async (db) => {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);

    if (!run) return { status: 'failed', error: `Run ${runId} not found.` };

    const skill = getSkill(run.skillKey);
    if (!skill) {
      const error = `No skill registered under key "${run.skillKey}".`;
      await markFailed(db, runId, error, startedAt);
      return { status: 'failed', error };
    }

    const context: SkillContext = {
      clientId: run.clientId,
      runId,
      db,
      anthropic: getAnthropic(),
      model: config.model,
      effort: config.effort,
      log: (message, meta) => console.info(`[agent:${run.skillKey}] ${message}`, meta ?? {}),
    };

    try {
      const input = skill.inputSchema.parse(run.input) as never;
      const output = await skill.run(input, context);

      if (skill.apply) {
        await skill.apply(output, context, input);
      }

      await db
        .update(agentRuns)
        .set({
          status: 'succeeded',
          output: output as Record<string, unknown>,
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
        })
        .where(eq(agentRuns.id, runId));

      return { status: 'succeeded', output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markFailed(db, runId, message, startedAt);
      return { status: 'failed', error: message };
    }
  });
}

async function markFailed(db: Db, runId: string, error: string, startedAt: number): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: 'failed',
      error: error.slice(0, 2000),
      completedAt: new Date(),
      durationMs: Date.now() - startedAt,
    })
    .where(eq(agentRuns.id, runId));
}

/** Run a skill immediately, bypassing the queue. Used by the broker's UI. */
export async function runSkillNow(
  clientId: string | null,
  skillKey: string,
  trigger: SkillTrigger,
  input: Record<string, unknown>,
): Promise<{ runId: string; result: RunResult }> {
  const runId = await asAgent((db) => queueSkill(db, { clientId, skillKey, trigger, input }));
  const result = await executeRun(runId);
  return { runId, result };
}

/** Recent runs for a client, newest first — powers the broker's activity panel. */
export async function recentRuns(db: Db, clientId: string, limit = 20) {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.clientId, clientId))
    .orderBy(sql`${agentRuns.createdAt} DESC`)
    .limit(limit);
}

/** Queued runs waiting for a worker — used by the health endpoint. */
export async function queueDepth(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'queued')))
    .orderBy(asc(agentRuns.createdAt));

  return rows[0]?.count ?? 0;
}
