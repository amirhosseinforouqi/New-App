/**
 * Application pathway.
 *
 * Stages are ordered and advance ONLY when the broker moves them. Nothing in
 * this codebase auto-advances a client — not an upload, not an agent run, not
 * a checklist completing. That is a deliberate product decision: the client's
 * position in the timeline is the broker's statement about the file, and it
 * would be worse than useless if the portal could promise "Conditional
 * Approval" before a lender had said so.
 */

export const STAGE_KEYS = [
  'inquiry',
  'documents_received',
  'under_review',
  'conditional_approval',
  'final_approval',
  'funded',
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

export interface StageDefinition {
  key: StageKey;
  label: string;
  /** Shown to the client. Written in second person, plain language. */
  clientDescription: string;
  /** Shown to the broker in the admin UI. */
  brokerHint: string;
  sortOrder: number;
}

export const STAGES: readonly StageDefinition[] = [
  {
    key: 'inquiry',
    label: 'Inquiry',
    clientDescription: 'We have your enquiry and your file is open.',
    brokerHint: 'Profile created. Checklist generated. Waiting on documents.',
    sortOrder: 1,
  },
  {
    key: 'documents_received',
    label: 'Documents Received',
    clientDescription: 'Your supporting documents are in and being organised.',
    brokerHint: 'Move here once the core checklist items are uploaded.',
    sortOrder: 2,
  },
  {
    key: 'under_review',
    label: 'Under Review',
    clientDescription: 'Your file is with underwriting for assessment.',
    brokerHint: 'File submitted to the lender. Awaiting underwriter response.',
    sortOrder: 3,
  },
  {
    key: 'conditional_approval',
    label: 'Conditional Approval',
    clientDescription:
      'Approved subject to conditions — we may ask for a few more items to finish up.',
    brokerHint: 'Lender approved with conditions. Track outstanding conditions as requests.',
    sortOrder: 4,
  },
  {
    key: 'final_approval',
    label: 'Final Approval',
    clientDescription: 'All conditions have been satisfied. Your mortgage is formally approved.',
    brokerHint: 'All conditions cleared. Instructions with the solicitor.',
    sortOrder: 5,
  },
  {
    key: 'funded',
    label: 'Funded',
    clientDescription: 'Funds have been advanced. Congratulations!',
    brokerHint: 'Deal closed and funded.',
    sortOrder: 6,
  },
] as const;

const BY_KEY = new Map<string, StageDefinition>(STAGES.map((stage) => [stage.key, stage]));

export function isStageKey(value: string): value is StageKey {
  return BY_KEY.has(value);
}

export function getStage(key: string): StageDefinition {
  const stage = BY_KEY.get(key);
  if (!stage) throw new Error(`Unknown pipeline stage "${key}".`);
  return stage;
}

export function stageIndex(key: string): number {
  return STAGES.findIndex((stage) => stage.key === key);
}

/** Progress as a 0–1 fraction, for the timeline's fill bar. */
export function stageProgress(key: string): number {
  const index = stageIndex(key);
  if (index < 0) return 0;
  return index / (STAGES.length - 1);
}

export type StageState = 'complete' | 'current' | 'locked';

/**
 * Classify every stage relative to the client's current one. "locked" is what
 * the client sees for anything ahead of them — greyed out, no dates, no
 * speculation about timing.
 */
export function stageStates(currentKey: string): Array<StageDefinition & { state: StageState }> {
  const current = stageIndex(currentKey);
  return STAGES.map((stage, index) => ({
    ...stage,
    state: index < current ? 'complete' : index === current ? 'current' : 'locked',
  }));
}

/**
 * Which stages the broker may move this client to.
 *
 * Forward moves are limited to the immediate next stage — skipping from
 * Inquiry straight to Funded is almost always a mis-click. Backward moves are
 * unrestricted, because correcting a premature advance needs to be easy.
 */
export function allowedTransitions(currentKey: string): StageKey[] {
  const current = stageIndex(currentKey);
  if (current < 0) return [...STAGE_KEYS];

  const allowed: StageKey[] = STAGES.slice(0, current).map((stage) => stage.key);
  const next = STAGES[current + 1];
  if (next) allowed.push(next.key);
  return allowed;
}

export function canTransition(fromKey: string, toKey: string): boolean {
  return allowedTransitions(fromKey).includes(toKey as StageKey);
}
