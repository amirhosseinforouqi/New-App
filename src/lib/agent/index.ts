/**
 * Agent layer entry point.
 *
 * Importing this module registers the built-in skills. Every process that can
 * trigger or execute a skill must import it — the web app does so via the
 * route handlers, the worker does so at boot.
 *
 * To add your own skills, register them here (or import a module that calls
 * `registerSkill`). Registration is idempotent per process and throws on
 * duplicate keys, so a copy-pasted key fails loudly at boot rather than
 * silently shadowing an existing skill.
 */

import { registerSkill, listSkills } from './registry';
import { classifyDocumentSkill } from './skills/classify-document';
import { generateChecklistSkill } from './skills/generate-checklist';
import { incomeVerificationSkill } from './skills/income-verification';

let registered = false;

export function registerBuiltInSkills(): void {
  if (registered) return;
  registered = true;

  registerSkill(generateChecklistSkill);
  registerSkill(classifyDocumentSkill);
  registerSkill(incomeVerificationSkill);

  // ── Register your own skills below ──────────────────────────────────────
  // registerSkill(myCustomSkill);
}

registerBuiltInSkills();

export { registerSkill, listSkills, getSkill, skillsForTrigger } from './registry';
export {
  dispatchTrigger,
  executeRun,
  claimNextRun,
  queueSkill,
  runSkillNow,
  recentRuns,
  queueDepth,
} from './runner';
export type { Skill, SkillContext, SkillTrigger } from './types';
