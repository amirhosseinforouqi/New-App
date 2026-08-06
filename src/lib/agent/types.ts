/**
 * The skill contract.
 *
 * This is the integration seam. A "skill" is a named, versioned unit of
 * mortgage processing work — classify a document, flag income inconsistencies,
 * build a checklist. Skills know nothing about HTTP, sessions, or Drive
 * plumbing; they receive a typed input and a context, and return typed output.
 *
 * To add your own, implement `Skill` and call `registerSkill()`. See
 * docs/AGENT_SKILLS.md for a worked example.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

import type { Db } from '@/db';

/** What caused a skill to run. */
export type SkillTrigger =
  | 'client.created'
  | 'document.uploaded'
  | 'stage.advanced'
  | 'manual'
  | 'scheduled';

export interface SkillContext {
  /** The client this run concerns. Null for skills that are not client-scoped. */
  readonly clientId: string | null;
  /** Row id in `agent_runs` — use it to correlate logs. */
  readonly runId: string;
  /**
   * Database handle already scoped to the `agent` actor, so RLS applies.
   * Skills get staff-level read access and must not be handed a client handle.
   */
  readonly db: Db;
  readonly anthropic: Anthropic;
  readonly model: string;
  readonly effort: string;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface Skill<TInput = unknown, TOutput = unknown> {
  /** Stable identifier, e.g. "checklist.generate". Stored in agent_runs.skill_key. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
  /** Triggers that fire this skill automatically. Empty = manual only. */
  readonly triggers: readonly SkillTrigger[];
  /**
   * Parses the stored `agent_runs.input` JSON into TInput.
   *
   * Typed with an `unknown` input side so schemas using `.default()` or
   * `.optional()` still fit — those make a field optional on the way in but
   * required on the way out, and pinning both sides to TInput would reject
   * every such schema.
   */
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  readonly outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  /**
   * Do the work. Throwing marks the run failed and records the message;
   * the runner handles persistence and timing.
   */
  run(input: TInput, context: SkillContext): Promise<TOutput>;
  /**
   * Optional side effects applied after a successful run — writing checklist
   * rows, updating a document's classification. Kept separate from `run` so a
   * skill can be dry-run in tests without mutating anything.
   *
   * Receives the original input as well as the output, because most writes
   * need to know what the run was about ("which document did we classify")
   * and not just what the model concluded.
   */
  apply?(output: TOutput, context: SkillContext, input: TInput): Promise<void>;
}

export class SkillError extends Error {
  constructor(
    message: string,
    readonly skillKey: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}
