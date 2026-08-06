# UWA — mortgage client portal

A secure client portal for a Canadian mortgage brokerage. A client emails you; the portal
creates their profile, generates credentials, builds a document checklist, and gives them a
private dashboard to upload documents, message you, and watch their application progress.

Built from a study of Finmo, Newton Velocity, Lendesk, BluMortgage and Blend — what was
taken from each, and what deliberately was not, is documented in
[`docs/RESEARCH.md`](docs/RESEARCH.md).

---

## What it does

**Client onboarding is automatic.** An email to your mailbox creates a profile, a Google
Drive folder, a tailored document checklist, and a credentials email — from your own
address, on your own domain. You can also add clients by hand; it is the same code path.

**The client dashboard** has three things and nothing else:

- **Application pathway** — a six-stage timeline from Inquiry to Funded. Stages ahead are
  visibly locked and carry no dates. Only you advance them.
- **Documents** — a checklist of what is needed, not a file manager. Uploads go straight to
  their folder in your Drive. Phone photos are first-class.
- **Messages** — a persistent thread with you. Not ephemeral chat; every message is stored
  and survives sign-out.

**Your workspace** shows every file in one list with the counts that decide what to do next
— awaiting review, outstanding, unread — plus stage control, document review, and the
agent's activity per client.

**The agent layer** runs mortgage processing skills: checklist generation on client
creation, document classification on upload, income verification on demand. Three reference
skills ship; the integration hooks are built for you to add your own without touching any
route or page.

---

## Security

| Requirement | How |
|---|---|
| Hashed passwords only | scrypt (N=65536, r=8, p=1) with per-password salts, versioned hash format, transparent upgrade on login. No plaintext anywhere. |
| Each client sees only their own data | **Postgres row-level security**, not application checks. Every query runs in a transaction bound to the caller's identity. Verified by 12 integration tests that query with no `WHERE` clause at all. |
| Authenticated document URLs | No public Drive links exist. Downloads proxy through a route that re-checks ownership per request and returns `404` — not `403` — for someone else's file. |
| Data in Canada | Postgres runs wherever you deploy it; put the machine in Canada. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) § Data residency for what PIPEDA actually requires, which is narrower than commonly assumed. |

Also: session tokens stored only as SHA-256, `httpOnly`/`sameSite`/`secure` cookies,
account lockout after five failed logins, constant-time login regardless of whether the
account exists, a strict Content-Security-Policy, and an append-only audit log.

**Known gap: there is no two-factor authentication.** Lendesk and Finmo both have it and it
is the most significant thing missing against them. It is the top item on the security
roadmap.

---

## See it running in 5 minutes

To look at the portal before configuring Google Drive, email or an Anthropic
key. Needs Docker and Node 22.

```bash
git clone <your-repo> uwa && cd uwa
npm install

# 1. Database
docker run -d --name uwa-db -p 5432:5432 \
  -e POSTGRES_DB=uwa -e POSTGRES_USER=uwa_owner -e POSTGRES_PASSWORD=devpw \
  postgres:16-alpine

export DATABASE_MIGRATION_URL="postgres://uwa_owner:devpw@localhost:5432/uwa"
export DATABASE_URL="postgres://uwa_app:devpw@localhost:5432/uwa"

npm run db:migrate
docker exec uwa-db psql -U uwa_owner -d uwa -c "ALTER ROLE uwa_app WITH PASSWORD 'devpw';"

# 2. Demo data — one broker, two clients at different stages
npm run db:demo

# 3. Run
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
npm run dev
```

Open <http://localhost:3000/login>:

| Sign in as | Username | Password |
|---|---|---|
| Client, mid-file | `pramanathan` | `demo-portal-2026` |
| Client, new enquiry | `mdelacroixwebb` | `demo-portal-2026` |
| Broker | `demo.broker@example.test` | `demo-portal-2026` |

Everything works except document downloads — the demo document records have no
bytes behind them in Drive, so those links 502. Uploads need real Drive
credentials; emails and agent skills need SMTP and an Anthropic key.

Tear down with `docker rm -f uwa-db`.

---

## Quick start

```bash
cp .env.example .env      # fill it in — see the setup guides below
npm install

docker compose up -d db
docker compose run --rm migrate

docker compose exec db psql -U uwa_owner -d uwa \
  -c "ALTER ROLE uwa_app WITH PASSWORD '<UWA_APP_PASSWORD from .env>';"

docker compose run --rm \
  -e DATABASE_MIGRATION_URL="postgres://uwa_owner:${POSTGRES_PASSWORD}@db:5432/uwa" \
  web npx tsx scripts/seed.ts "you@your-domain.ca" "Your Name"

docker compose up -d
curl -s http://localhost:3000/api/health?verbose=1 | jq
```

Full walkthrough: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Setup guides

| | |
|---|---|
| [Google Drive](docs/GOOGLE_DRIVE_SETUP.md) | Shared Drive + service account. Read the first section — the quota trap breaks most Drive integrations. |
| [Email](docs/EMAIL_SETUP.md) | SMTP out, IMAP in, on your own mailbox. Includes deliverability. |
| [Agent skills](docs/AGENT_SKILLS.md) | The skill contract and how to add your own. |
| [Architecture](docs/ARCHITECTURE.md) | Stack rationale, RLS design, data residency. |
| [Research](docs/RESEARCH.md) | What was taken from each competitor, and what was not. |

---

## Development

```bash
npm run dev          # http://localhost:3000
npm run typecheck
npm test             # unit tests; RLS tests skip without a database
npm run build

npm run worker:mail  # inbound email → client profiles
npm run worker:agent # executes queued agent skills
```

To run the row-level security tests — worth doing after any policy change:

```bash
UWA_TEST_DATABASE_URL=postgres://uwa_app:pw@localhost:5432/uwa npm test
```

They create two clients and assert that neither can reach the other's documents, messages
or stage history, that a client cannot forge a broker message or self-approve a document,
and that identity does not leak between pooled connections.

---

## Layout

```
drizzle/            schema (0001) and RLS policies (0002)
src/
  app/              pages and API routes
  components/       timeline, document panel, message thread
  db/               schema + the actor-scoped query layer
  lib/
    agent/          skill contract, registry, runner, built-in skills
    auth/           password hashing, sessions, username generation
    drive/          Google Drive client and operations
    mail/           SMTP sending, IMAP inbound, templates
    pipeline/       stage definitions and transition rules
  workers/          inbound-mail and agent worker processes
scripts/            migrate, seed
tests/              unit + RLS integration
docs/               setup and architecture
```

---

## Notes and trade-offs

Three decisions worth knowing about before you run this in production. Each is explained in
full in the docs.

**Credential emails contain a password.** The alternative — a magic link — leaves the
client with no durable credential. Mitigated by high entropy, a forced change on first
login, and session revocation on change; in practice the emailed value is single-use.
Switching to a token link is a small change, described in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) § Onboarding.

**Live message push is in-process.** Correct for a single container. With multiple web
replicas messages still persist and appear on refresh, but SSE reaches only the emitting
instance. Swap the two-function events module for Postgres `LISTEN/NOTIFY` at that point.

**Document classification sends content to Anthropic.** That is a cross-border transfer and
belongs in your privacy notice. The agent layer is entirely optional — leave
`ANTHROPIC_API_KEY` unset and the portal works fully, with checklists built by hand.

---

## Not built

`docs/RESEARCH.md` has the full table with reasoning. The headlines: no two-factor
authentication, no lender submission (Filogix/Velocity), no e-signature, no credit bureau
pull, no online application form, and no automated reminder cadence.
