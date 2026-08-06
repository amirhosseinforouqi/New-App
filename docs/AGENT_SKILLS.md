# Agent skills

You said you would define the mortgage processing skills separately and asked for the
integration hooks. This is that seam, plus three working skills as reference
implementations.

## The contract

A skill is a typed unit of work. It knows nothing about HTTP, sessions, cookies or Drive
plumbing.

```ts
interface Skill<TInput, TOutput> {
  key: string;                       // 'income.verify' — stored in agent_runs.skill_key
  title: string;                     // shown on the broker's button
  description: string;
  triggers: SkillTrigger[];          // [] = manual only
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;

  run(input: TInput, ctx: SkillContext): Promise<TOutput>;
  apply?(output: TOutput, ctx: SkillContext, input: TInput): Promise<void>;
}
```

**`run` computes; `apply` writes.** Keeping them separate means a skill can be exercised in
a test without mutating anything, and it makes "what does this skill actually change"
answerable by reading one function.

`SkillContext` gives you `clientId`, `runId`, a database handle already scoped to the
`agent` actor, a configured Anthropic client, the model and effort settings, and a logger.

## Triggers

| Trigger | Fires when |
|---|---|
| `client.created` | A client profile is created — from an email or by hand |
| `document.uploaded` | A client uploads a file |
| `stage.advanced` | The broker moves a client's stage |
| `manual` | The broker presses the button on the client page |
| `scheduled` | Reserved — nothing emits this yet |

Portal code never names a skill. It emits a trigger:

```ts
await dispatchTrigger(db, 'document.uploaded', { clientId, input: { ... } });
```

Every skill registered for that trigger is queued. **Adding a skill therefore touches no
route, no page and no upload handler.**

---

## Writing one

`src/lib/agent/skills/flag-large-deposits.ts`:

```ts
import { z } from 'zod';
import { structuredCall } from '../anthropic';
import type { Skill } from '../types';

const inputSchema = z.object({ clientId: z.string().uuid() });

const outputSchema = z.object({
  deposits: z.array(z.object({
    date: z.string(),
    amount: z.number(),
    needsSourcing: z.boolean(),
    reason: z.string(),
  })),
  summary: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

// Structured outputs require additionalProperties:false and an explicit
// `required` list on EVERY object. Omitting either is the usual cause of a 400.
const jsonSchema = {
  type: 'object',
  properties: {
    deposits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          amount: { type: 'number' },
          needsSourcing: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['date', 'amount', 'needsSourcing', 'reason'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['deposits', 'summary'],
  additionalProperties: false,
};

export const flagLargeDepositsSkill: Skill<Input, Output> = {
  key: 'deposits.flag',
  title: 'Flag deposits needing sourcing',
  description: 'Reviews bank statements for deposits a lender will ask the client to source.',
  triggers: ['manual'],
  inputSchema,
  outputSchema,

  async run(input, ctx) {
    const result = await structuredCall<Output>({
      system: 'You review Canadian bank statements for a mortgage brokerage…',
      schema: jsonSchema,
      model: ctx.model,
      effort: ctx.effort,
      content: [{ type: 'text', text: '…' }],
    });
    return outputSchema.parse(result.data);
  },
};
```

Register it in `src/lib/agent/index.ts`:

```ts
import { flagLargeDepositsSkill } from './skills/flag-large-deposits';

export function registerBuiltInSkills(): void {
  // …
  registerSkill(flagLargeDepositsSkill);
}
```

It now appears on every client page as a button, is runnable via
`POST /api/broker/agent/run`, and records every run in `agent_runs`. Nothing else changes.

Registration throws on a duplicate key, so a copy-pasted key fails loudly at boot rather
than silently shadowing an existing skill.

---

## Built-in skills

### `checklist.generate` — trigger: `client.created`

The one that answers *"when a new client profile is created, the agent should begin a
checklist based on application type."* Writes `document_requests` rows marked
`created_by = 'agent'`, so you can always tell which items a human asked for.

The prompt is explicitly Canadian — T4, T1, NOA, T2, APS, provincial property tax. A
generic mortgage prompt produces W-2s and 1040s, which is worse than useless here.

### `document.classify` — trigger: `document.uploaded`

Reads the actual file from Drive and identifies it. PDFs go as document blocks, images as
image blocks.

Two design decisions worth knowing:

- **It never approves anything.** Classification says "this is a 2024 Notice of Assessment";
  only you say "this is acceptable". That boundary keeps the four-state document model
  meaningful.
- **A legibility problem moves the document straight to `needs_attention`**, so a cropped
  scan reaches the client's "action needed" list without waiting for you to open it.

Only a *high-confidence, problem-free* match closes a checklist item. Medium and low leave
it outstanding — a wrong match is worse than no match, because it hides an outstanding
requirement.

### `income.verify` — trigger: `manual`

Reviews classified income documents and reports flags at three severities (`info`,
`review`, `blocker`).

**It produces flags, not decisions.** The output schema has nowhere to put a
recommendation, and the prompt says so explicitly. It also has no `apply()` — flags live on
the `agent_runs` row and are shown to you; they never mutate the client's file.

---

## Model configuration

```bash
ANTHROPIC_MODEL=claude-opus-5   # default
ANTHROPIC_EFFORT=high           # low | medium | high | xhigh | max
```

`structuredCall()` in `src/lib/agent/anthropic.ts` handles the details:

- **Adaptive thinking on.** Document work is careful reading; this is where it pays.
- **Structured outputs** via `output_config.format`, not prompt-and-hope. (Assistant
  prefill, the old way to force JSON, returns a 400 on Opus 5.)
- **Streaming.** With a large `max_tokens` a non-streaming request can exceed the SDK's
  HTTP timeout, surfacing as a confusing socket error.
- **Refusals handled.** Opus 5's safety classifiers can decline with a normal HTTP 200 and
  `stop_reason: "refusal"`. Reading `content[0]` without checking would throw something
  unhelpful; instead you get a message telling you to review the document by hand.

Lowering `ANTHROPIC_EFFORT` to `medium` is a reasonable cost lever — classification is not
the hardest task these models do. Raise to `xhigh` for income verification if you find it
missing discrepancies.

---

## Execution and failure

Runs are queued in `agent_runs` and executed by a **separate worker process**
(`npm run worker:agent`). A skill run is a multi-second model call; running it inline would
hold a client's upload request open for its duration.

Multiple workers are safe — `claimNextRun` uses `FOR UPDATE SKIP LOCKED`.

A thrown error marks the run `failed` and records the message. **It does not retry.** For
document classification that is the right default: a re-run costs tokens and the broker can
see the failure and press the button. If you want retries, add an attempt counter to
`agent_runs` and re-queue in the worker's error branch.

Every run records input, output, duration and token usage — visible in the broker's Agent
panel, expandable to the raw JSON.

---

## Turning the agent off

The portal is fully functional without it. Leave `ANTHROPIC_API_KEY` unset and do not run
the agent worker: uploads, messaging, the timeline and document review all work, and you
build checklists by hand with the "Request a document" button.

This is also the answer if sending document content to a third party is unacceptable for
your privacy posture — see `docs/ARCHITECTURE.md` § Data residency.
