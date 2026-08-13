# UWA — mortgage client portal

A secure client portal for a Canadian mortgage brokerage. A client emails you; the portal
creates their profile, generates credentials, builds a document checklist, and gives them a
private dashboard to upload documents, message you, and watch their application progress.

Built from a study of Finmo, Newton Velocity, Lendesk, BluMortgage and Blend — what was
taken from each, and what deliberately was not, is documented in
[`docs/RESEARCH.md`](docs/RESEARCH.md).

**Architecture, stack reasoning, schema and the full lead-to-funded flow (with diagrams):**
[`docs/PLATFORM.md`](docs/PLATFORM.md). **Public API and webhooks:** [`docs/API.md`](docs/API.md).

---

## What it does

**Client onboarding is automatic.** An email to your mailbox creates a profile, a Google
Drive folder, a tailored document checklist, and a credentials email — from your own
address, on your own domain. You can also add clients by hand; it is the same code path.

**The public application at `/apply`** is bilingual (English/French), adaptive, and comes in
three lengths — a two-minute estimate, a working application, or the full file. Questions
appear and disappear based on what has already been answered: a buyer is never asked their
current lender, a condo buyer is asked their condo fees, a self-employed borrower is asked
for two years. Submitting it creates the client, the deal, their income and liability
records, and a separate independent login for any co-borrower. `?ref=CODE` on the link
attributes the lead; `?lang=fr` opens it in French.

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
| Two-factor authentication | TOTP (RFC 6238) for brokers and clients, with hashed single-use recovery codes and replay protection. |

Also: session tokens stored only as SHA-256, `httpOnly`/`sameSite`/`secure` cookies,
account lockout after five failed logins, constant-time login regardless of whether the
account exists, a strict Content-Security-Policy, and an append-only audit log.

**Two-factor authentication** is available to both brokers and clients: TOTP implemented
against RFC 6238 and verified against the RFC's own test vectors, ten single-use recovery
codes hashed like passwords, and single-use enforcement so an observed code cannot be
replayed inside its window. A session that has passed the password but not the second factor
reaches nothing but the verification screen.

---

## See it running — in your browser, no install

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/amirhosseinforouqi/New-App/tree/claude/uwa-mortgage-portal-8ot5zi)

Click the badge (or **Code → Codespaces → Create codespace on this branch** on GitHub). The
codespace boots the same demo stack described below automatically — Postgres, migrations,
seed data, dev server — no Docker, no local setup, nothing to install on your machine.

First boot takes a minute or two while it installs dependencies and seeds the database.
Codespaces will pop up a notification to open port 3000 in the browser once the server is
listening; if you miss it, open the **Ports** tab and click the globe icon next to `3000`, or
run `docker compose -f ../docker-compose.demo.yml logs -f app` in the terminal to watch
progress. Sign in with the credentials below.

## See it running locally — one command

To look at the portal before configuring Google Drive, email or an Anthropic key.
Needs Docker only.

```bash
docker compose -f docker-compose.demo.yml up
```

Postgres starts, migrations apply, demo data seeds, and the app comes up at
<http://localhost:3000/login> (in Codespaces, the forwarded `3000` port instead). Tear it
down with `docker compose -f docker-compose.demo.yml down`.

| Sign in as | Username | Password |
|---|---|---|
| Client, mid-file | `pramanathan` | `demo-portal-2026` |
| Client, new enquiry | `mdelacroixwebb` | `demo-portal-2026` |
| Broker | `demo.broker@example.test` | `demo-portal-2026` |

The deals board is at **Broker → Deals**, and the public bilingual application — the thing a
prospective borrower would actually fill in — is at `/apply` (unauthenticated, linked from
the board's "Application link" button). The calculators at `/calculators` need no login
either.

Everything works except document downloads — the demo document records have no bytes behind
them in Drive, so those links 502. Uploads need real Drive credentials; emails and agent
skills need SMTP and an Anthropic key.

<details>
<summary>Prefer to run it directly, without Docker for the app?</summary>

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

Open <http://localhost:3000/login> — same credentials as above. Tear down with
`docker rm -f uwa-db`.

</details>

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
drizzle/            schema (0001), RLS policies (0002), deals + intake (0003)
src/
  app/              pages and API routes
  components/       timeline, document panel, message thread
  db/               schema + the actor-scoped query layer
  lib/
    agent/          skill contract, registry, runner, built-in skills
    auth/           password hashing, sessions, username generation
    drive/          Google Drive client and operations
    finance/        Canadian mortgage maths — payments, GDS/TDS/LTV, land transfer tax
    intake/         the public application: question definitions, mapping, submission
    mail/           SMTP sending, IMAP inbound, templates
    pipeline/       stage definitions and transition rules
  workers/          inbound-mail and agent worker processes
scripts/            migrate, seed
tests/              unit + RLS integration
docs/               PLATFORM (architecture + flows), API, setup guides, research
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

## State of the platform

**Built and working.** Bilingual tiered intake with conditional branching · deals as
first-class objects with co-borrowers on independent logins · Canadian mortgage maths
(semi-annual compounding, GDS/TDS/LTV at the stress-test rate, default insurance, land
transfer tax) · Kanban pipeline with drag, assignment, application lock and archiving ·
lender product matching with reasons for every rejection · submission-readiness gating ·
FINTRAC compliance checklists expanded per borrower · cross-sell screening · commission
splitting to the cent · two-factor authentication (TOTP + recovery codes) · automated
document reminders with an SMS adapter · renewal mining · public calculators · public API
with signed webhooks · Google Drive document handling · the Claude agent layer.

**Schema and engine exist, no interface yet.** Electronic consent capture (the `consents`
table hashes the document so what was agreed to is provable, but nothing renders the signing
screen) · commission entry and the team performance dashboard · team invitations and roles ·
deal copying · referral link generation and its attribution report · down-payment source
auditing · a client dashboard that switches between multiple deals.

Each of those is a route and a form on top of work that is already done and tested. They are
listed here rather than implied as finished.

**Blocked on a commercial relationship, not on engineering.** A credit bureau pull needs an
Equifax or TransUnion membership. Bank statement aggregation needs Flinks or Plaid. CRA tax
packages need Represent a Client. Filogix import needs a licensed API. Certified e-signature
needs a vendor. Two-way lender submission and a database of 3,000+ lender policies need those
lender relationships and a data subscription. SMS needs a Twilio account — the adapter is
written and switches on with three environment variables.

The database is shaped to receive all of them: `borrower_liabilities.source` lets
bureau-parsed debts sit beside self-declared ones, `external_connections` records a borrower
authorising a provider, `lender_submissions.method` already distinguishes an export from an
API call, and every ratio in `src/lib/finance` recalculates unchanged. None can be built
without the account behind it, and faking a regulated feature in a mortgage application is
worse than not having it — a portal that displays a credit score it never pulled is a
compliance problem, not a demo.

`docs/RESEARCH.md` has the full comparison against Finmo, Velocity, Lendesk and BluMortgage.
`docs/PLATFORM.md` has the architecture, schema and end-to-end flow.
