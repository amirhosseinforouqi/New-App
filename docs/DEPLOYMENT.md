# Deployment

Built provider-agnostic, per your answer. The same Docker Compose file runs on a VPS in
Toronto, a Canadian cloud VM, or your laptop. Nothing here is tied to a host — which is
what keeps the data-residency decision yours.

## Where to run it

If Canadian residency matters to you (see `docs/ARCHITECTURE.md` § Data residency for what
PIPEDA actually requires), pick a machine in Canada:

| Option | Notes |
|---|---|
| **VPS in Toronto or Montreal** | DigitalOcean TOR1, Vultr Toronto, OVH Beauharnois. Cheapest, fully under your control. 2 vCPU / 4 GB is comfortable. |
| **AWS `ca-central-1` / `ca-west-1`** | Montreal / Calgary. Best compliance story for an audit. Most setup. |
| **Azure Canada Central** | Equivalent to the above if you are already in the Microsoft ecosystem. |
| **Fly.io `yyz`** | Toronto. Good middle ground — Docker-native, minimal ops. |

Everything below is the same regardless.

---

## First deployment

### 1. Prerequisites

- Docker and Docker Compose
- A domain with DNS pointing at the machine
- The Google Drive service account key at `secrets/uwa-drive-sa.json`
  (see `docs/GOOGLE_DRIVE_SETUP.md`)
- SMTP/IMAP credentials (see `docs/EMAIL_SETUP.md`)

### 2. Configure

```bash
git clone <your-repo> uwa && cd uwa
cp .env.example .env
```

Generate the secrets:

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('POSTGRES_PASSWORD=' + require('crypto').randomBytes(24).toString('base64url'))"
node -e "console.log('UWA_APP_PASSWORD=' + require('crypto').randomBytes(24).toString('base64url'))"
```

Fill in `.env`. `APP_URL` must be the real external URL — it builds the login links in
credential emails, so `localhost` there means every client gets a dead link.

```bash
chmod 600 .env
mkdir -p secrets && chmod 700 secrets
```

### 3. Database

```bash
docker compose up -d db
docker compose run --rm migrate
```

The migration creates the schema, the RLS policies, and the `uwa_app` role. Set that role's
password to match `UWA_APP_PASSWORD`:

```bash
docker compose exec db psql -U uwa_owner -d uwa \
  -c "ALTER ROLE uwa_app WITH PASSWORD '<UWA_APP_PASSWORD>';"
```

> **Do not point `DATABASE_URL` at the owner role.** Postgres exempts table owners from
> row-level security, so the app would run with every policy inert and nothing would look
> wrong. This split is the reason there are two URLs.

### 4. Your broker account

```bash
docker compose run --rm \
  -e DATABASE_MIGRATION_URL="postgres://uwa_owner:${POSTGRES_PASSWORD}@db:5432/uwa" \
  web npx tsx scripts/seed.ts "you@your-domain.ca" "Your Name"
```

Copy the printed password — it is shown once and is not recoverable. Change it after
signing in.

(Broker creation deliberately requires the owner role: `uwa_app` has no INSERT permission
on `brokers`, so an application-level compromise cannot mint itself an admin account.)

### 5. Start

```bash
docker compose up -d
curl -s http://localhost:3000/api/health?verbose=1 | jq
```

All three checks should be `ok`. If Drive or SMTP fails, the response names which and why —
fix it before onboarding a real client.

---

## TLS

Terminate TLS at a reverse proxy. Caddy is the least work:

```caddy
portal.your-domain.ca {
    reverse_proxy localhost:3000

    # SSE needs buffering off, or live messages arrive in batches.
    header {
        -Server
    }
}
```

With nginx, the SSE route needs explicit handling — buffering on is the default and it
breaks the message stream entirely:

```nginx
location /api/messages/stream {
    proxy_pass http://localhost:3000;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}

location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 30M;   # must exceed MAX_UPLOAD_BYTES
}
```

**Do not skip TLS.** Session cookies are marked `secure` in production, so over plain HTTP
nobody can log in — and you would be sending mortgage documents in the clear.

---

## Backups

Two things need backing up, and they are separate:

**Postgres** — clients, messages, checklist state, audit log:

```bash
docker compose exec -T db pg_dump -U uwa_owner uwa | gzip > uwa-$(date +%F).sql.gz
```

Nightly, off the machine, and **test a restore before you need one**.

**Google Drive** — the document bytes. Google's own durability covers hardware failure but
not deletion. Trashed files are recoverable for 30 days; beyond that, Workspace Vault or a
third-party Drive backup covers you.

Postgres holds Drive *file ids*, not bytes. Restoring only the database gives you a portal
whose downloads all fail. They are one backup story, not two.

---

## Updating

```bash
git pull
docker compose build
docker compose run --rm migrate     # no-op when there are no new migrations
docker compose up -d
```

Migrations are recorded in `_migrations` and are safe to re-run.

---

## Operations

**Logs**

```bash
docker compose logs -f web
docker compose logs -f mail-worker
docker compose logs -f agent-worker
```

**Monitoring** — poll `/api/health` (cheap, database only). Use `?verbose=1` sparingly; it
makes live Drive and SMTP calls.

**Scaling** — a single-broker practice will not need it. Two caveats if you add web
replicas:

1. Live message push is in-process (see `docs/ARCHITECTURE.md` § Realtime). Messages still
   persist and appear on refresh, but SSE reaches only the emitting instance.
2. Run exactly **one** mail worker. Multiple workers on one mailbox will race; the
   `inbound_emails` ledger prevents duplicate profiles, but it is pointless work. Agent
   workers are safe to run several of.

**Session cleanup** — `pruneExpiredSessions()` exists but nothing calls it on a schedule.
Expired sessions are rejected on lookup regardless, so this is housekeeping, not security.
A weekly cron is plenty.

---

## Pre-launch checklist

- [ ] `.env` is `chmod 600` and not in git
- [ ] `secrets/` is `chmod 700` and not in git
- [ ] `DATABASE_URL` uses `uwa_app`, **not** `uwa_owner`
- [ ] `APP_URL` is the real external URL
- [ ] TLS terminating, HTTP redirecting to HTTPS
- [ ] `/api/health?verbose=1` all green
- [ ] Test enquiry from an address you control produced a profile and a credentials email
- [ ] That email arrived in the **inbox**, not spam — check SPF/DKIM if not
- [ ] Logged in as the test client, uploaded a file, confirmed it landed in the right Drive
      folder
- [ ] Advanced the test client a stage and confirmed the email
- [ ] `pg_dump` runs and the output restores
- [ ] Test client deleted
- [ ] Broker password changed from the seeded one
