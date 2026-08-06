/**
 * Skill registry and trigger dispatch.
 *
 * The registry is the wiring point between portal events and mortgage
 * processing logic. Nothing in the portal calls a skill by name directly;
 * it emits a trigger, and whatever skills are registered for that trigger run.
 *
 * That indirection is the whole point: you can drop in new skills without
 * touching the upload route, the onboarding flow, or the stage controller.
 */

import type { Skill, SkillTrigger } from './types';

const registry = new Map<string, Skill<never, never>>();

export function registerSkill<TInput, TOutput>(skill: Skill<TInput, TOutput>): void {
  if (registry.has(skill.key)) {
    throw new Error(
      `Skill "${skill.key}" is already registered. Skill keys must be unique — ` +
        'they are stored in agent_runs.skill_key and used to correlate history.',
    );
  }
  registry.set(skill.key, skill as unknown as Skill<never, never>);
}

export function getSkill(key: string): Skill<never, never> | undefined {
  return registry.get(key);
}

export function listSkills(): Skill<never, never>[] {
  return [...registry.values()];
}

export function skillsForTrigger(trigger: SkillTrigger): Skill<never, never>[] {
  return [...registry.values()].filter((skill) => skill.triggers.includes(trigger));
}

/** Test helper. Not used at runtime. */
export function resetRegistry(): void {
  registry.clear();
}
