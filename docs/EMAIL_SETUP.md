# Email setup

You chose **your own mailbox on your own domain**. The portal both sends from and reads
that mailbox, so clients only ever see mail from an address they recognise, and enquiries
that arrive there automatically become client profiles.

Two connections, same mailbox:

- **SMTP (outbound)** — credential emails, stage changes, document requests, message alerts
- **IMAP (inbound)** — a worker watches the inbox and creates a client profile from a new
  sender

This works with any provider. Google Workspace instructions are below since that is what
you have.

---

## Google Workspace

### 1. Turn on IMAP

Gmail → **Settings → See all settings → Forwarding and POP/IMAP** → **Enable IMAP** → Save.

### 2. Create an App Password

Your normal account password will not work once 2-Step Verification is on (and it should
be on).

1. <https://myaccount.google.com/security> → enable **2-Step Verification** if it is not
2. <https://myaccount.google.com/apppasswords>
3. Create one named `UWA Portal`
4. Copy the 16-character value

> If App Passwords is missing, your Workspace admin has disabled it. Ask them to allow it,
> or use OAuth 2.0 instead — `nodemailer` and `imapflow` both support XOAUTH2, and only
> `src/lib/mail/smtp.ts` and the worker's connection setup would change.

### 3. Configure

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@your-domain.ca
SMTP_PASSWORD=<the 16-character app password>
MAIL_FROM_NAME="Your Name — Mortgage Broker"
MAIL_FROM_ADDRESS=you@your-domain.ca
MAIL_REPLY_TO=you@your-domain.ca

IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=you@your-domain.ca
IMAP_PASSWORD=<the same app password>
IMAP_MAILBOX=INBOX
IMAP_PROCESSED_FOLDER=UWA/Processed
```

### 4. Verify

```bash
curl -s http://localhost:3000/api/health?verbose=1 | jq .checks.smtp
```

---

## Deliverability

**Keep `MAIL_FROM_ADDRESS` on the same domain as `SMTP_USER`.** Because you authenticate as
the mailbox owner, SPF and DKIM already pass for your domain. Changing the From address to a
different domain breaks alignment and is the single most reliable way to land credential
emails in spam — which the client then never sees, and cannot log in.

Worth checking once, since a client who never receives their password is a silent failure:

- **SPF** — Workspace: `v=spf1 include:_spf.google.com ~all`
- **DKIM** — Workspace Admin → Apps → Google Workspace → Gmail → Authenticate email
- **DMARC** — start at `v=DMARC1; p=none; rua=mailto:you@your-domain.ca`, tighten later

---

## How inbound works

```
Client emails you
      ↓
IMAP worker sees the unseen message (IDLE, or the poll fallback)
      ↓
Record in `inbound_emails` keyed on Message-ID     ← dedupe happens here, first
      ↓
Ignore? (auto-reply, newsletter, your own address, ignore list)
      ↓
Known sender? → append to their portal thread
New sender?   → create profile, Drive folder, checklist, credentials email
      ↓
Mark seen, move to UWA/Processed
```

### Why it does not create profiles from junk

Three filters, in order:

1. **`INBOUND_IGNORE_LIST`** — substring match on the sender. Defaults cover
   `no-reply@`, `noreply@`, `mailer-daemon@`, `postmaster@`. Add your own team and any
   newsletters.
2. **Automated-mail headers** — `Auto-Submitted`, `List-Id`, `List-Unsubscribe`,
   `Precedence: bulk`, plus subject heuristics for out-of-office and bounce messages.
   Without this, one vacation autoresponder loop creates client profiles for your own mail
   server.
3. **Your own address** is never onboarded from its own sent mail.

Everything that gets filtered is still recorded in `inbound_emails` with its outcome, so
you can see what was skipped and why.

### Dedupe

Every message is written to `inbound_emails` keyed on its RFC `Message-ID` **before** any
action is taken. Redelivery, a worker restart mid-message, or a re-fetch is a no-op. The
worker is at-least-once; the ledger makes the effect exactly-once.

Messages are marked seen regardless of outcome — a message that throws would otherwise be
retried forever.

### Running it

```bash
npm run worker:mail        # or the mail-worker service in docker compose
```

It uses IMAP IDLE where the server supports it, so new mail is handled within seconds, and
falls back to polling every `IMAP_POLL_INTERVAL` seconds. Both run — some servers drop IDLE
silently, and a slow poll costs nothing while turning a missed notification into a
one-minute delay rather than a permanent one.

---

## Testing without emailing a real person

Send yourself a message from an address you control that is **not** in the ignore list and
is not `IMAP_USER` — a personal Gmail works. Within a minute:

- a client profile appears at `/broker`
- that address receives credentials
- the enquiry is the first message in the portal thread

Then delete the test client from `/broker` before going live.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Invalid login: 535-5.7.8` | Using the account password, not an App Password |
| `Application-specific password required` | 2-Step Verification is on but no App Password was created |
| Worker connects, no profiles created | Messages already marked read — the worker only looks at unseen mail |
| Emails land in spam | `MAIL_FROM_ADDRESS` on a different domain than `SMTP_USER`, or missing DKIM |
| `Mailbox does not exist` | `IMAP_PROCESSED_FOLDER` could not be created. The worker warns and continues, leaving mail in place |
| Duplicate profiles | Should not happen — onboarding is idempotent on email. Check for two addresses for the same person |
