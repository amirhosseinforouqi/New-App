# Architecture

## Stack, and why

You asked for "whatever gives the most reliable production output, preferring
well-documented open source", and chose **portable** for hosting. Every choice below
follows from those two constraints.

| Layer | Choice | Reasoning |
|---|---|---|
| App | Next.js 15 (App Router), TypeScript | One deployable for UI and API. Server components mean client data is fetched under the client's own database identity rather than through an API the browser could call with someone else's id. |
| Database | PostgreSQL 16 | Row-level security is the requirement, and Postgres has the best implementation of it. Runs anywhere. |
| Query layer | Drizzle ORM | Thin. Generates predictable SQL, and does not fight raw SQL where RLS needs it. |
| Auth | Custom sessions + scrypt | No dependency on an auth SaaS (which would put session data outside Canada). scrypt is in Node's standard library — no native build step, which is the most common cause of "works locally, fails in the container". |
| Files | Google Drive API | Your requirement. Service account on a Shared Drive. |
| Email | SMTP out + IMAP in (`nodemailer`, `imapflow`) | Your own mailbox on your own domain, per your answer. Portable across any provider — including Google Workspace — with no vendor lock-in. |
| Realtime | Server-Sent Events | No extra process, no extra dependency, automatic reconnect. |
| Agent | Anthropic SDK, `claude-opus-5` | Document classification and income review are careful-reading tasks where model capability shows up directly. |
| Deploy | Docker Compose | Runs identically on a Toronto VPS, a Canadian cloud VM, or your laptop. Nothing ties it to a provider. |

**No React state library, no component library, no CSS-in-JS.** The interface is a
timeline, a list, and a chat box. Tailwind plus a small set of component classes covers it,
and every dependency avoided is one that cannot break your deployment in eighteen months.

---

## Row-level security — the core security property

Your requirement was *"each client can only see their own data — enforce row-level
security."* That is implemented in the database, not the application.

### How it works

`src/db/index.ts` exposes no way to query outside an actor context. Every query runs inside
`withActor()`, which opens a transaction and sets two Postgres session variables:

```sql
SET LOCAL app.actor_type = 'client';
SET LOCAL app.client_id  = '<uuid>';
```

The policies in `drizzle/0002_rls.sql` read those settings. A client sees a row only when
`client_id = app_client_id()`.

### Three details that make it real

**1. `SET LOCAL`, not `SET`.** `SET LOCAL` is scoped to the transaction. When the
connection returns to the pool it carries no identity. A plain `SET` would leak the
previous request's identity to whoever borrows that connection next — a catastrophic and
very quiet bug. There is a test for exactly this
(`tests/rls.test.ts` → "does not leak identity between pooled connections").

**2. The app connects as a non-owner, non-superuser role.** Postgres exempts table owners
and superusers from RLS *by default*. An RLS setup where the app connects as the owner is
completely inert and looks fine. Hence two URLs: `DATABASE_MIGRATION_URL` (owner, used by
`npm run db:migrate`) and `DATABASE_URL` (`uwa_app`, used by everything else). There is a
test asserting the app role has neither `rolsuper` nor `rolbypassrls`.

**3. Write policies constrain content, not just ownership.** The `messages` insert policy
requires `sender_type = 'client'`, so a client cannot forge a message that appears to come
from you — the "your mortgage is approved, send the deposit here" attack. Likewise the
`documents` insert policy pins `status = 'in_review'`, so a client cannot self-approve a
document, and clients have no insert permission at all on `client_stage_history`, which is
what makes "stages advance only when the broker says so" true at the storage layer rather
than only in the UI.

### Verified, not asserted

`tests/rls.test.ts` runs 12 assertions against a real database, including queries with **no
`WHERE` clause at all** — proving the filtering is the database's doing, and a direct IDOR
attempt naming another client's id.

```
UWA_TEST_DATABASE_URL=postgres://uwa_app:...@host/uwa npm test
```

---

## Request flow

```
Browser
  │
  ├── Server component (dashboard, broker pages)
  │     └── withActor(client) ─── BEGIN; SET LOCAL app.*; query; COMMIT
  │
  └── Route handler (/api/*)
        ├── getCurrentUser()  ← session cookie → sessions table
        ├── authorization check
        └── withActor(...) ─── same transaction discipline
```

Session cookies hold a 32-byte random token; only its SHA-256 is stored, so a database dump
yields no usable sessions. Cookies are `httpOnly`, `sameSite=lax` and `secure` in
production.

---

## Onboarding

The sequence, and why it is ordered this way:

1. Insert the client row, seed stage history at `inquiry` — **one transaction**
2. Create the Google Drive folder, store its id
3. Queue the checklist skill
4. Send credentials by email

**Steps 2–4 run after the transaction commits, deliberately.** Drive and SMTP are
third-party calls that can be slow or fail. Holding a database transaction open across them
causes lock contention, and a failure would roll back a client who genuinely enquired. So
if Drive or email fails, the client still exists, the broker sees a specific warning, and
the step can be retried — a far better failure mode than losing the enquiry.

The whole thing is **idempotent on email address**: a client who emails three times gets
one profile and one set of credentials. This matters because the inbound mail worker is
at-least-once by design.

### On emailing a password

The credentials email contains a generated password. That is a considered trade-off, not an
oversight.

The alternative — a magic link — means the client has no durable credential and must return
to their inbox on every visit. For a portal they will use over weeks, that is worse.

It is mitigated by: 93 bits of entropy, a forced change on first login
(`clients.must_change_password`), and every session being revoked when the password changes.
In practice the emailed value is single-use.

**If you would rather not email passwords at all**, the change is small: replace the
password in `welcomeEmail()` with a signed, single-use, time-limited token; add a
`setup_token` column; have `/change-password` accept the token instead of a current
password. The rest of the flow is unchanged.

---

## Documents

Bytes live in Google Drive. Postgres stores metadata and the Drive file id. **There is no
public URL column, by design.** Downloads go through `/api/documents/[id]/download`, which:

- re-checks ownership on every request, under the requester's own RLS context
- returns `404`, not `403`, for someone else's document — so the response does not confirm
  the id exists
- sets `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, so an
  uploaded HTML or SVG file can never execute in the portal's origin
- sets `Cache-Control: private, no-store`

Drive permissions are never widened to "anyone with the link".

---

## Agent layer

Three pieces:

- **`Skill`** (`src/lib/agent/types.ts`) — a typed unit of work: input schema, output
  schema, `run()`, optional `apply()`. Knows nothing about HTTP or sessions.
- **Registry** (`registry.ts`) — maps keys and triggers to skills.
- **Runner** (`runner.ts`) — queues, claims and executes runs, recording input, output,
  duration and errors in `agent_runs`.

Portal code never names a skill. It emits a trigger:

```ts
await dispatchTrigger(db, 'document.uploaded', { clientId, input: {...} });
```

Every skill registered for that trigger gets queued. Adding a skill therefore touches no
route, no page and no upload handler. See `docs/AGENT_SKILLS.md`.

Skills run under the `agent` actor, which RLS grants staff-level access — a classification
skill legitimately needs to read across a client's whole file. They are never handed a
client-scoped handle.

The agent worker is a **separate process**. A skill run is a multi-second model call;
running it inline would hold a client's upload request open for its duration. Multiple
workers are safe — `claimNextRun` uses `FOR UPDATE SKIP LOCKED`.

---

## Realtime

`src/lib/events.ts` is an in-process pub/sub feeding SSE. **Stated limit:** it delivers only
to browsers connected to the same Node process. That is correct for the single-container
deployment this is built for.

If you scale to multiple web replicas, messages are still persisted and still appear on
refresh, but live push reaches only clients attached to the emitting instance. The fix is
Postgres `LISTEN/NOTIFY` (the database is already there) or Redis. The interface is
deliberately two functions wide to keep that a contained change.

---

## Data residency (PIPEDA)

Worth being precise, because the popular framing is wrong.

**PIPEDA does not require personal data to stay in Canada.** It requires that you remain
accountable for it: comparable protection through contractual means, transparency with
clients about cross-border transfer, and appropriate safeguards. Many Canadian brokerages
nonetheless choose Canadian hosting because it is simpler to explain and forecloses the
question.

This build gives you that choice rather than making it:

- **Postgres** runs wherever you run the container. Put the machine in Canada and all
  application data — clients, messages, document metadata, audit log — is in Canada.
- **Google Drive** holds the document bytes. Google Workspace offers data-region policies;
  set yours to Canada if that matters to you. Configure it before uploading real client
  files, since the policy applies going forward.
- **Anthropic** processes document content during classification. This is a cross-border
  transfer and should appear in your privacy notice. If that is unacceptable, the agent
  layer is optional — the portal is fully functional with `ANTHROPIC_API_KEY` unset and no
  agent worker running; you simply build checklists by hand.

The honest summary: **hosting location is a deployment decision, not a code decision**, and
this codebase is written so it stays that way.
