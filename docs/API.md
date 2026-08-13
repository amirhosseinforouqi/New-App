# Public API

For connecting the portal to Zapier, a CRM, your website's lead form, or your own scripts.

Base URL is your deployment's origin. Everything lives under `/api/v1/`, and the version is in
the path so the contract can change later without breaking what you have already built.

---

## Authentication

Create a key at **Settings → Integrations** (brokerage owner only — a key can read every file,
so it is not something an individual agent account issues).

```
Authorization: Bearer uwa_live_a1b2c3d4_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The key is shown **once**. Only its SHA-256 is stored, so it cannot be recovered — if you lose
it, revoke it and issue another.

Two scopes:

| Scope | Allows |
|---|---|
| `read` | `GET` endpoints |
| `write` | `read`, plus creating leads |

A missing or unknown key returns `401`. A key without the needed scope returns `403`.

---

## `GET /api/v1/deals`

Every deal in the brokerage, newest activity first.

**Query parameters**

| Name | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | 25 | Capped at 100 |
| `stage` | string | — | `inquiry`, `documents_received`, `under_review`, `conditional_approval`, `final_approval`, `funded` |
| `status` | string | — | `active`, `archived`, `funded`, `lost` |

```bash
curl https://portal.example.ca/api/v1/deals?stage=under_review \
  -H "Authorization: Bearer uwa_live_..."
```

```json
{
  "object": "list",
  "count": 1,
  "has_more": false,
  "data": [
    {
      "id": "6f1c…",
      "reference": "UWA-2026-0002",
      "deal_type": "purchase",
      "stage": "under_review",
      "status": "active",
      "mortgage_amount": 600000,
      "purchase_price": 850000,
      "property": { "city": "Toronto", "province": "ON" },
      "maturity_date": null,
      "lead_source": "intake_form",
      "referral_code": "REALTOR-JB",
      "primary_borrower": { "name": "Priya Ramanathan", "email": "priya@example.test" },
      "created_at": "2026-02-01T14:22:09.000Z",
      "updated_at": "2026-02-18T09:05:41.000Z"
    }
  ]
}
```

---

## `POST /api/v1/leads`

Creates a client profile, a deal, a Drive folder, a generated document checklist and a
credentials email — exactly as if the person had filled in `/apply` themselves. It runs the same
code path, so there is no second implementation to drift.

Requires `write` scope.

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `full_name` | string | yes | |
| `email` | string | yes | Idempotent — an existing client gets a second deal, not a duplicate login |
| `phone` | string | no | |
| `deal_type` | string | no | `purchase` (default), `refinance`, `renewal`, `heloc`, `preapproval` |
| `timeline` | string | no | `asap`, `1_3_months`, `3_6_months`, `6_plus`, `just_looking` |
| `purchase_price` | number | no | |
| `down_payment` | number | no | |
| `property_value` | number | no | For refinances |
| `existing_balance` | number | no | For refinances |
| `annual_income` | number | no | |
| `employment_type` | string | no | |
| `province` | string | no | Two letters, e.g. `ON` |
| `city` | string | no | |
| `notes` | string | no | Shapes the generated checklist |
| `referral_code` | string | no | Attribution |
| `source` | string | no | Recorded on the application, e.g. `website`, `facebook` |

```bash
curl -X POST https://portal.example.ca/api/v1/leads \
  -H "Authorization: Bearer uwa_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Jordan Fisher",
    "email": "jordan@example.ca",
    "deal_type": "purchase",
    "purchase_price": 750000,
    "down_payment": 150000,
    "province": "ON",
    "source": "website"
  }'
```

```json
{
  "object": "lead",
  "reference": "UWA-2026-0043",
  "existing_client": false,
  "credentials_emailed": true,
  "warnings": []
}
```

**Consent.** The API asserts consent on the caller's behalf, because the borrower is not present
at the moment of the call. You are responsible for having collected it on the form that fed this
request. The application record notes that it arrived via the API rather than the portal.

---

## Webhooks

Add an endpoint at **Settings → Integrations**. We `POST` JSON when things happen.

**Events**

`application.submitted` · `client.created` · `deal.created` · `deal.stage_changed` ·
`deal.funded` · `document.uploaded` · `document.approved` · `message.received`

Selecting none subscribes to all of them.

**Payload**

```json
{
  "id": "8c0a…",
  "event": "deal.funded",
  "createdAt": "2026-02-18T09:05:41.000Z",
  "data": { "reference": "UWA-2026-0002" }
}
```

**Verifying the signature.** Every delivery carries `X-UWA-Signature`:

```
X-UWA-Signature: t=1800000000,v1=5f3a…
```

Compute HMAC-SHA256 over `{t}.{raw body}` with your endpoint's signing secret and compare:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const timestamp = Number(parts.t);

  // Reject anything stale. The timestamp is INSIDE the signed payload, so a
  // captured delivery cannot be replayed with a fresh one.
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

Sign the **raw** body, not a re-serialised object — key order changes and the signature fails.

**Delivery.** At-least-once, with five attempts on exponential backoff (roughly 1, 2, 4, 8 and 16
minutes). Your endpoint must be idempotent; the payload's `id` is stable across retries. Anything
outside `2xx` is a failure and will be retried. Endpoints must be `https` — payloads are signed
but not encrypted.

---

## Rate limits and errors

The public intake at `/api/apply` is limited to 5 submissions per IP per hour. The keyed
endpoints are not currently rate-limited; if you are polling `/deals`, once a minute is plenty.

| Status | Meaning |
|---|---|
| `400` | Malformed body. `details` names the offending fields |
| `401` | Missing or unknown key |
| `403` | Key lacks the scope |
| `429` | Rate limited |
| `500` | Our fault — the response body says nothing useful on purpose; check your logs and ours |

---

## What is not here yet

`GET /api/v1/deals/{id}` for a single deal with borrowers, documents and ratios, and `PATCH` to
advance a stage. Both are small additions on top of what exists — the query layer in
`src/lib/deals/queries.ts` already returns those shapes — but they are not built, and this
document lists what you can call today rather than what is planned.
