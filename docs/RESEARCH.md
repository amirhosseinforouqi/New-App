# Competitive research: what UWA borrows, and from where

Research conducted August 2026 against Finmo, Newton Velocity, Lendesk, BluMortgage and
Blend.

## Method, and its limits

State this plainly up front, because it bounds how much weight the findings carry.

The **actual borrower portals of all five products sit behind client logins**, and no
public demo account exists for any of them. Finmo, Lendesk, Newton and Blend also return
`403` to automated page fetches. So this is **not** a screenshot-based UI teardown.

What it is: a synthesis of each vendor's own product and help-centre documentation, which
for Finmo in particular is unusually detailed — their help centre documents the exact
document-status vocabulary and the Smart Documents rule engine, which is more useful than
a screenshot would have been. Where a claim below comes from marketing copy rather than
operational documentation, it is marked *(marketing)* and weighted accordingly.

**What this means for you:** the interaction patterns and data models below are well
evidenced. The *visual* design is an interpretation of the design language these products
describe and display in public marketing screenshots, not a reproduction of their actual
logged-in UI.

---

## Finmo (Lendesk) — the strongest source

Finmo is the closest analogue to what you asked for, and contributed the most.

### The four-state document model — adopted wholesale

Finmo segments every document into **Requested → For your Review → Needs Attention →
Approved**. This is the single best idea found in the research, and UWA implements it
exactly (`document_status` in `drizzle/0001_init.sql`).

Why it beats the obvious alternative (a simple uploaded/not-uploaded flag): it separates
*the client's obligation* from *the broker's obligation*. "For your Review" is a queue for
the broker. "Needs Attention" is a queue for the client. A binary flag collapses those
into one pile and the broker loses track of what they owe versus what they are owed.

One deviation: UWA renders **different labels for each audience** (`src/components/status-badge.tsx`).
"For your review" is an instruction to the broker; a client reading those words on their
own dashboard would think the ball is in their court. Same state, different wording —
Finmo's vocabulary is broker-facing throughout.

### Smart Documents — adopted, and made the agent's job

Finmo auto-generates a required-document list from the application details, driven by
configurable rules, and prompts the borrower for each item.

UWA does the same thing but replaces the rules engine with a model call
(`src/lib/agent/skills/generate-checklist.ts`). The trade-off is deliberate:

- **Rules engine**: predictable, auditable, and needs a rule written for every situation.
- **Model**: handles "self-employed, incorporated 2019, co-applicant on maternity leave"
  without anyone having anticipated that combination — at the cost of needing review.

UWA hedges by marking agent-created checklist items with `created_by = 'agent'`, which the
broker sees in the UI. You can always tell which items a human asked for.

### Checklist-as-upload-target — adopted

Finmo's borrower does not see a file manager; they see a list of what is needed, and
upload *against an item*. UWA's `DocumentPanel` follows this. It makes "what do I still
owe you" answerable at a glance, which is the client's actual question.

### Automated reminders — deliberately NOT adopted

Finmo sends reminder emails on the broker's behalf. UWA does not, yet. Automated nagging
from an address the client believes is a person is a trust problem, and the right cadence
is brokerage-specific. The data to build it is all present (`document_requests.status`,
`created_at`) — see "Not built" below.

---

## Newton Velocity — mobile capture

Velocity's contribution is one specific insight, and it is a good one:

> Clients can upload on-the-go from their mobile camera roll, and documents are
> auto-converted to PDF.

This reflects how uploads actually happen. Asking a client to find a scanner, produce a
PDF and email it is where files stall for a week. UWA's upload input sets `accept` to
include image types and permits multiple selection, and HEIC (the iPhone default) is in
the allowlist — which is easy to forget and produces a baffling rejection for iPhone users
if you do.

**Not implemented: server-side image→PDF conversion.** Velocity does this; UWA stores the
image as uploaded. Claude reads images directly for classification, so nothing downstream
is blocked, but a lender submission package would want it. Noted below.

Velocity also files uploads directly into the deal, "minimising steps" *(marketing)* —
the same principle as UWA writing straight to the client's Drive folder.

---

## Lendesk — security posture as a stated feature

Lendesk's documentation emphasises **two-factor authentication and encrypted transfer** on
borrower uploads.

UWA's current position: TLS in transit, Drive's encryption at rest, hashed passwords,
authenticated-only document URLs, and row-level security. **Two-factor authentication is
not implemented** — this is the most significant gap against Lendesk and is called out in
the README as the top item on the security roadmap. The `sessions` table would need a
second factor recorded at issue time.

Lendesk's "documents are reviewed to ensure they meet standards before submission" is the
same job UWA's `document.classify` skill does with its `legibilityIssue` field — a cropped
scan or a screenshot of a banking app gets flagged before it wastes an underwriter's time.

---

## BluMortgage — the broker's side

BluMortgage is a CRM rather than a client portal, so it informed the *broker* views:

- **A single pipeline with stage counts.** UWA's `/broker` page shows a count per stage
  above the client list.
- **Checklists to manage documents and outstanding conditions.** The insight is that
  conditions arriving after conditional approval are the same object as initial document
  requests — one table (`document_requests`), not two.
- **Audit trail as a first-class feature.** UWA has `audit_log` with every stage change,
  document review and login recorded.

BluMortgage's real strength is integrations (Velocity, Filogix, Finmo, Floify). UWA has
none — see below.

---

## Blend — the visual and interaction benchmark

Blend informed the *feel* more than the feature set:

- **Educational, dynamic questioning; self-serve.** Every UWA checklist item carries a
  description written as an actionable instruction ("All pages, as issued by the CRA"),
  not a bare label. The prompt in `generate-checklist.ts` requires this explicitly.
- **Centralised status monitoring** of loans, outstanding requests and borrower activity
  → the broker's client list surfaces `awaiting review`, `outstanding` and `unread` counts
  per client without opening the file.
- **Restraint in the visual language.** Near-white surfaces, one accent colour, generous
  line height. UWA's design tokens (`src/app/globals.css`) follow this. A mortgage client
  is often anxious and usually on a phone; calm and legible beats characterful.

---

## The pipeline stages

The six stages come from the standard Canadian/North American mortgage flow, corroborated
across several lender-education sources: application → conditional approval → satisfying
conditions → underwriter review → final approval → clear to close/funded.

UWA compresses "satisfying conditions" and "underwriter review" into `under_review`,
because from the client's side those are one waiting period, and a portal that shows two
adjacent boxes both meaning "still waiting" invites a phone call rather than preventing
one.

**Every stage is manually advanced.** This was your requirement and it is also the right
one: the stage is the broker's *statement* about the file. A portal that auto-advanced to
"Conditional Approval" because a checklist completed would be making a promise no lender
had made. `canTransition()` additionally limits forward movement to one stage at a time
while allowing free backward correction.

---

## Deliberately not built

Being explicit about the gaps, because "clone the best features" invites the assumption
that everything made it in.

| Feature | Present in | Why not here |
|---|---|---|
| **Two-factor authentication** | Lendesk, Finmo | The clearest security gap. Top of the roadmap. |
| Lender submission (Filogix/Velocity) | All five | Requires vendor credentials and partner agreements. Nothing here can substitute. |
| E-signature | Finmo, BluMortgage | Needs a DocuSign-class integration; out of scope for this build. |
| Automated reminder cadence | Finmo | Trust and cadence decisions are yours; the data model supports it. |
| Credit bureau pull | Velocity, Finmo | Regulated integration requiring your own bureau agreement. |
| Image → PDF conversion | Velocity | Classification reads images directly; matters for lender packaging. |
| Application intake form | All five | UWA starts from an email, per your brief. There is no online application form. |
| Affordability / GDS-TDS calculators | Velocity, Filogix | Not requested; sizeable and needs its own correctness testing. |

---

## Sources

- [Finmo Borrower Portal — Lendesk](https://www.lendesk.com/borrower-portal)
- [Finmo — Lendesk](https://www.lendesk.com/finmo)
- [How to review document uploads and mark them with the correct status — Finmo Help Centre](https://help.finmo.ca/en/articles/3308733-how-to-review-document-uploads-and-mark-them-with-the-correct-status)
- [How to use Smart Documents to request documents automatically — Finmo Help Centre](https://help.finmo.ca/en/articles/3308505-how-to-use-smart-documents-to-request-documents-automatically)
- [How to upload documents as a borrower — Finmo Help Centre](https://help.finmo.ca/en/articles/3196338-how-to-upload-documents-as-a-borrower)
- [Document collection — Finmo Help Centre](https://help.finmo.ca/en/collections/1918942-document-collection)
- [Client Portal — Newton Connectivity Systems](https://newton.ca/client-portal/)
- [Velocity — Newton Connectivity Systems](https://newton.ca/velocity/)
- [Velocity vs Filogix — BluMortgage](https://blumortgage.ca/velocity-vs-filogix/)
- [Lendesk Offers Documentation Collection Solution — Canadian Mortgage Trends](https://www.canadianmortgagetrends.com/2018/02/lendesk-level-documentation-collection/)
- [Best Mortgage CRM Software — BluMortgage](https://blumortgage.ca/)
- [Mortgage CRM Software: Data Security — BluMortgage](https://blumortgage.ca/data-security/)
- [Digital Origination: Blend Home Lending](https://blend.com/products/mortgage-suite/)
- [About the Blend Platform](https://blend.com/platform/)
- [Conditional approval: A guide — Rocket Mortgage](https://www.rocketmortgage.com/learn/conditional-approval)
- [Mortgage Loan Processing: The 12 Stages Between Application and Closing — Amerisave](https://www.amerisave.com/learn/mortgage-loan-processing-in-the-stages-between-application-and-closing)
- [Canadian Data Residency: Cloud Rules, PIPEDA, and Risk — Pilotcore](https://pilotcore.io/blog/canadian-data-residency-and-the-public-cloud)
- [Data Residency Requirements for Canadian Software in 2026 — Droz Technologies](https://www.droztechnologies.com/blog/data-residency-canada-software-requirements)
