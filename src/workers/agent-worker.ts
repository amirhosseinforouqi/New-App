/**
 * Agent worker.
 *
 * Polls `agent_runs` for queued work and executes it. Kept separate from the
 * web process on purpose: a skill run is a multi-second model call, and
 * running it inline would hold a client's upload request open for the
 * duration.
 *
 * Safe to run more than one instance — `claimNextRun` uses
 * `FOR UPDATE SKIP LOCKED`, so workers never collide on the same row.
 *
 * Run with:  npm run worker:agent
 */

import 'dotenv/config';

import { asAgent } from '@/db';
import { claimNextRun, executeRun } from '@/lib/agent';
import '@/lib/agent';

const IDLE_DELAY_MS = 3000;
const ERROR_BACKOFF_MS = 10_000;

let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(): Promise<boolean> {
  const claimed = await asAgent((db) => claimNextRun(db));
  if (!claimed) return false;

  console.info('[agent-worker] executing run', { runId: claimed.id });
  const result = await executeRun(claimed.id);

  if (result.status === 'failed') {
    console.error('[agent-worker] run failed', { runId: claimed.id, error: result.error });
  } else {
    console.info('[agent-worker] run succeeded', { runId: claimed.id });
  }

  return true;
}

async function main() {
  console.info('[agent-worker] starting');

  const shutdown = (signal: string) => {
    console.info(`[agent-worker] ${signal} received, finishing current run then exiting`);
    shuttingDown = true;
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (!shuttingDown) {
    try {
      const didWork = await tick();
      // Only sleep when the queue was empty — otherwise drain it at full speed.
      if (!didWork) await sleep(IDLE_DELAY_MS);
    } catch (error) {
      console.error('[agent-worker] loop error', error);
      await sleep(ERROR_BACKOFF_MS);
    }
  }

  console.info('[agent-worker] stopped');
  process.exit(0);
}

main().catch((error) => {
  console.error('[agent-worker] fatal', error);
  process.exit(1);
});
