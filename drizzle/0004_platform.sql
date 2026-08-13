-- ---------------------------------------------------------------------------
-- UWA Portal — the rest of the platform
--
-- Everything the origination workflow needs beyond deals and intake: team
-- structure and commissions, reminders, compliance evidence, consents, lender
-- products and scenarios, cross-sell screening, the public API, and the
-- integration seams for the services that require a commercial account.
--
-- Design note that runs through the whole file: where a feature depends on a
-- vendor we do not have (a credit bureau, a bank aggregator, a certified
-- e-signature authority), the TABLE still exists and carries a `source` or
-- `provider` column. That is deliberate. It means the day the account is
-- signed, the integration writes into a shape everything downstream already
-- reads, instead of a migration landing in the middle of a working system.
-- ---------------------------------------------------------------------------

-- ── Team structure ───────────────────────────────────────────────────────────
-- A brokerage is not a flat list of brokers. An assistant must be able to chase
-- documents without seeing commissions; a compliance manager must see every
-- file; an agent sees their own. Role is on the broker row rather than a
-- separate table because there are four of them and they change rarely.

DO $$ BEGIN
  CREATE TYPE broker_role AS ENUM ('owner', 'agent', 'assistant', 'compliance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE brokers ADD COLUMN IF NOT EXISTS role broker_role NOT NULL DEFAULT 'agent';
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS licence_number text;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS brokerage_name text;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS brokerage_address text;
-- Lender submission identifiers. Every lender portal wants these and they are
-- per-agent, so they cannot live in environment configuration.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS equifax_member_number text;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS expert_profile_number text;
-- Default share of a deal's commission, overridable per deal.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS commission_split_percent numeric NOT NULL DEFAULT 100;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES brokers(id) ON DELETE SET NULL;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS invite_accepted_at timestamptz;

-- The first broker in an empty brokerage owns it.
UPDATE brokers SET role = 'owner'
 WHERE id = (SELECT id FROM brokers ORDER BY created_at LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM brokers WHERE role = 'owner');

-- ── Document reminders ───────────────────────────────────────────────────────
-- Due dates on the request, and a log of what was actually sent. The log is
-- what stops a client being emailed the same nag six times because a worker
-- restarted; it is also the evidence trail when someone says "nobody told me".

ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS doc_requests_due_idx
  ON document_requests (due_at)
  WHERE due_at IS NOT NULL AND status IN ('requested', 'needs_attention');

DO $$ BEGIN
  CREATE TYPE reminder_channel AS ENUM ('email', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS reminder_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES deals(id) ON DELETE CASCADE,
  channel      reminder_channel NOT NULL,
  destination  text NOT NULL,
  subject      text,
  body         text NOT NULL,
  -- Which requests this reminder covered, so a follow-up can say "still these".
  request_ids  uuid[] NOT NULL DEFAULT '{}',
  succeeded    boolean NOT NULL,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reminder_log_client_idx ON reminder_log (client_id, created_at DESC);

-- ── Consents and signatures ──────────────────────────────────────────────────
-- An electronic signature under PIPEDA / provincial e-commerce acts needs the
-- signer's intent, the exact document they agreed to, and a record that ties
-- the two together and cannot be quietly edited afterwards.
--
-- `document_hash` is a SHA-256 of the rendered consent text. That is what makes
-- this defensible: it proves WHAT was agreed to, not just that a checkbox was
-- ticked. Change the wording later and the hash no longer matches, which is
-- exactly the property you want.
--
-- This is NOT a certified/qualified electronic signature under EU eIDAS or a
-- notarised instrument. For consent forms, credit-pull authorisations and
-- privacy acknowledgements — which is what a brokerage actually needs — an
-- audit-trailed record of this shape is the normal standard of proof.

CREATE TABLE IF NOT EXISTS consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  deal_id        uuid REFERENCES deals(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  version        text NOT NULL,
  document_title text NOT NULL,
  document_body  text NOT NULL,
  document_hash  text NOT NULL,
  -- The typed name is the signature. Storing it separately from the client's
  -- profile name matters: a mismatch is a real signal worth being able to see.
  signed_name    text NOT NULL,
  signed_at      timestamptz NOT NULL DEFAULT now(),
  ip_address     text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consents_client_idx ON consents (client_id, signed_at DESC);
CREATE INDEX IF NOT EXISTS consents_deal_idx ON consents (deal_id);

-- ── Lender products ──────────────────────────────────────────────────────────
-- The brokerage's own product table. This is NOT a licensed feed of every
-- Canadian lender policy — that is a paid data subscription — but the engine,
-- the matching rules and the comparison UI are the same either way, and a
-- licensed feed imports straight into these tables.

CREATE TABLE IF NOT EXISTS lenders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  lender_type   text NOT NULL DEFAULT 'a_lender',
  submission_email text,
  submission_url   text,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS lender_products (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id             uuid NOT NULL REFERENCES lenders(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  rate_type             text NOT NULL DEFAULT 'fixed',
  term_years            numeric NOT NULL DEFAULT 5,
  posted_rate           numeric NOT NULL,
  -- Everything below is a QUALIFICATION RULE. A null means "no constraint",
  -- which is why they are nullable rather than defaulted — a default of 0 for
  -- min_credit_score would silently exclude every borrower.
  min_credit_score      integer,
  max_ltv               numeric,
  max_gds               numeric,
  max_tds               numeric,
  max_amortization      integer,
  min_loan_amount       numeric,
  max_loan_amount       numeric,
  allows_insured        boolean NOT NULL DEFAULT true,
  allows_uninsured      boolean NOT NULL DEFAULT true,
  allows_rental         boolean NOT NULL DEFAULT true,
  allows_self_employed  boolean NOT NULL DEFAULT true,
  allowed_provinces     text[],
  allowed_deal_types    text[],
  notes                 text,
  is_active             boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lender_products_lender_idx ON lender_products (lender_id) WHERE is_active;

-- A saved side-by-side comparison. Stored rather than recomputed so the numbers
-- a borrower was shown on a given date can be reproduced exactly.
CREATE TABLE IF NOT EXISTS scenarios (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  name         text NOT NULL,
  product_ids  uuid[] NOT NULL DEFAULT '{}',
  snapshot     jsonb NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES brokers(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scenarios_deal_idx ON scenarios (deal_id, created_at DESC);

-- ── Lender submissions ───────────────────────────────────────────────────────
-- A record of every package sent to a lender. `method` distinguishes what
-- actually happened: an export the broker uploaded by hand, an email, or (when
-- a lender API relationship exists) a direct submission.

DO $$ BEGIN
  CREATE TYPE submission_method AS ENUM ('export', 'email', 'api');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS lender_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  lender_id    uuid REFERENCES lenders(id) ON DELETE SET NULL,
  product_id   uuid REFERENCES lender_products(id) ON DELETE SET NULL,
  method       submission_method NOT NULL DEFAULT 'export',
  status       text NOT NULL DEFAULT 'submitted',
  payload      jsonb NOT NULL DEFAULT '{}',
  response     text,
  submitted_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lender_submissions_deal_idx ON lender_submissions (deal_id, submitted_at DESC);

-- ── Commissions ──────────────────────────────────────────────────────────────
-- Lender finder's fee on a funded deal, and how it divides. Split rows rather
-- than columns because a deal can involve an agent, a referring agent and the
-- brokerage, and that list is not fixed.

CREATE TABLE IF NOT EXISTS deal_commissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  lender_id         uuid REFERENCES lenders(id) ON DELETE SET NULL,
  funded_amount     numeric NOT NULL DEFAULT 0,
  finders_fee_percent numeric NOT NULL DEFAULT 0,
  volume_bonus      numeric NOT NULL DEFAULT 0,
  total_commission  numeric NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending',
  paid_at           timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id)
);

CREATE TABLE IF NOT EXISTS commission_splits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id  uuid NOT NULL REFERENCES deal_commissions(id) ON DELETE CASCADE,
  broker_id      uuid REFERENCES brokers(id) ON DELETE SET NULL,
  -- Free text so an external referral partner who is not a portal user can
  -- still appear on the split sheet.
  payee_name     text NOT NULL,
  percent        numeric NOT NULL DEFAULT 0,
  amount         numeric NOT NULL DEFAULT 0,
  role           text NOT NULL DEFAULT 'agent',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commission_splits_commission_idx ON commission_splits (commission_id);

-- ── Cross-sell screening ─────────────────────────────────────────────────────
-- Screening, NOT selling. A row here means "this file matches the conditions
-- for X, mention it" — it never contacts anyone on its own, because an
-- automated insurance solicitation is a regulated act.

CREATE TABLE IF NOT EXISTS cross_sell_opportunities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  product_key  text NOT NULL,
  rationale    text NOT NULL,
  priority     integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'suggested',
  dismissed_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, product_key)
);

CREATE INDEX IF NOT EXISTS cross_sell_deal_idx ON cross_sell_opportunities (deal_id);

-- ── Public API and webhooks ──────────────────────────────────────────────────
-- Only the SHA-256 of an API key is stored, same as session tokens. The plaintext
-- is shown once at creation and is unrecoverable afterwards — a key table you
-- can read is a key table an attacker can read.

CREATE TABLE IF NOT EXISTS api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id   uuid REFERENCES brokers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  key_prefix  text NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  scopes      text[] NOT NULL DEFAULT '{read}',
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (key_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id   uuid REFERENCES brokers(id) ON DELETE CASCADE,
  url         text NOT NULL,
  events      text[] NOT NULL DEFAULT '{}',
  -- Used to sign the payload so the receiver can verify it came from us.
  secret      text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id   uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        text NOT NULL,
  payload      jsonb NOT NULL,
  status_code  integer,
  error        text,
  attempts     integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON webhook_deliveries (created_at)
  WHERE delivered_at IS NULL;

-- ── Renewal / lifecycle campaigns ────────────────────────────────────────────
-- What was sent, to whom, about which maturing mortgage. Prevents a client
-- being mined twice for the same renewal and gives the broker a history.

CREATE TABLE IF NOT EXISTS lifecycle_touches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals(id) ON DELETE CASCADE,
  campaign    text NOT NULL,
  channel     reminder_channel NOT NULL DEFAULT 'email',
  succeeded   boolean NOT NULL DEFAULT true,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, campaign)
);

-- ── Compliance evidence ──────────────────────────────────────────────────────
-- FINTRAC identity verification is a record-keeping obligation with a specific
-- shape: which method was used, what was examined, by whom, when. A generic
-- checklist tick does not satisfy it, so it gets its own table.

CREATE TABLE IF NOT EXISTS identity_verifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  deal_id        uuid REFERENCES deals(id) ON DELETE CASCADE,
  method         text NOT NULL,
  document_type  text,
  document_number text,
  issuing_jurisdiction text,
  document_expiry date,
  verified_by    uuid REFERENCES brokers(id) ON DELETE SET NULL,
  verified_at    timestamptz NOT NULL DEFAULT now(),
  -- PEP / HIO screening is a separate obligation from identity verification.
  pep_screened   boolean NOT NULL DEFAULT false,
  pep_result     text,
  pep_screened_at timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_verifications_deal_idx ON identity_verifications (deal_id);

-- ── Down payment audit ───────────────────────────────────────────────────────
-- The 90-day source-of-funds trail lenders require. Rows can come from a broker
-- reading statements or from the agent skill reading them; `source` records
-- which, because an AI-derived finding needs a human to stand behind it.

CREATE TABLE IF NOT EXISTS down_payment_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,
  source_type   text NOT NULL DEFAULT 'savings',
  institution   text,
  amount        numeric NOT NULL DEFAULT 0,
  as_of_date    date,
  is_verified   boolean NOT NULL DEFAULT false,
  -- Deposits a lender will question: large, round, and unexplained.
  flagged       boolean NOT NULL DEFAULT false,
  flag_reason   text,
  source        actor_type NOT NULL DEFAULT 'broker',
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS down_payment_sources_deal_idx ON down_payment_sources (deal_id);

-- ── External connections (bank / CRA / bureau) ───────────────────────────────
-- The seam. Each row is one borrower authorising one provider. Until a provider
-- account exists, `status` stays 'unavailable' and the UI says so rather than
-- pretending to offer a connection that cannot be made.

CREATE TABLE IF NOT EXISTS external_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  deal_id       uuid REFERENCES deals(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  provider      text NOT NULL,
  status        text NOT NULL DEFAULT 'unavailable',
  external_ref  text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  detail        text
);

CREATE INDEX IF NOT EXISTS external_connections_deal_idx ON external_connections (deal_id);

-- ── Push subscriptions (installable client app) ──────────────────────────────

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- ── Submission readiness rules ───────────────────────────────────────────────
-- Custom validation the brokerage defines, evaluated before a file can be
-- marked ready for a lender. Stored as data so a compliance manager can change
-- them without a deploy.

CREATE TABLE IF NOT EXISTS validation_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id    uuid REFERENCES brokers(id) ON DELETE CASCADE,
  name         text NOT NULL,
  rule_key     text NOT NULL,
  severity     text NOT NULL DEFAULT 'blocking',
  deal_type    text,
  config       jsonb NOT NULL DEFAULT '{}',
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Row-level security ───────────────────────────────────────────────────────
-- Same pattern throughout: staff see everything, a client sees only rows tied
-- to a deal they are a borrower on (or to themselves).

ALTER TABLE reminder_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_log             FORCE  ROW LEVEL SECURITY;
ALTER TABLE consents                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE lenders                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lenders                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE lender_products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE lender_products          FORCE  ROW LEVEL SECURITY;
ALTER TABLE scenarios                ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios                FORCE  ROW LEVEL SECURITY;
ALTER TABLE lender_submissions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE lender_submissions       FORCE  ROW LEVEL SECURITY;
ALTER TABLE deal_commissions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_commissions         FORCE  ROW LEVEL SECURITY;
ALTER TABLE commission_splits        ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_splits        FORCE  ROW LEVEL SECURITY;
ALTER TABLE cross_sell_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_sell_opportunities FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_keys                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhooks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries       FORCE  ROW LEVEL SECURITY;
ALTER TABLE lifecycle_touches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_touches        FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity_verifications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_verifications   FORCE  ROW LEVEL SECURITY;
ALTER TABLE down_payment_sources     ENABLE ROW LEVEL SECURITY;
ALTER TABLE down_payment_sources     FORCE  ROW LEVEL SECURITY;
ALTER TABLE external_connections     ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_connections     FORCE  ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions       FORCE  ROW LEVEL SECURITY;
ALTER TABLE validation_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_rules         FORCE  ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  reminder_log, consents, lenders, lender_products, scenarios, lender_submissions,
  deal_commissions, commission_splits, cross_sell_opportunities, api_keys,
  webhooks, webhook_deliveries, lifecycle_touches, identity_verifications,
  down_payment_sources, external_connections, push_subscriptions, validation_rules
TO uwa_app;

-- Staff-only tables. A borrower has no business reading the brokerage's product
-- table, its commissions, or its API keys.
CREATE POLICY reminder_log_staff       ON reminder_log             FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY lenders_staff            ON lenders                  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY lender_products_staff    ON lender_products          FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY scenarios_staff          ON scenarios                FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY submissions_staff        ON lender_submissions       FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY commissions_staff        ON deal_commissions         FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY commission_splits_staff  ON commission_splits        FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY cross_sell_staff         ON cross_sell_opportunities FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY api_keys_staff           ON api_keys                 FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY webhooks_staff           ON webhooks                 FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY webhook_deliveries_staff ON webhook_deliveries       FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY lifecycle_staff          ON lifecycle_touches        FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY identity_staff           ON identity_verifications   FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY validation_rules_staff   ON validation_rules         FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

-- Client-visible. A borrower reads their own consents but cannot alter one
-- after signing — an editable signature record is not evidence of anything.
CREATE POLICY consents_client_read     ON consents FOR SELECT USING (client_id = app_client_id());
CREATE POLICY consents_client_sign     ON consents FOR INSERT WITH CHECK (client_id = app_client_id());
CREATE POLICY consents_staff           ON consents FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY down_payment_staff       ON down_payment_sources FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY down_payment_client_read ON down_payment_sources FOR SELECT USING (client_id = app_client_id());

CREATE POLICY external_conn_staff      ON external_connections FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY external_conn_client     ON external_connections FOR ALL
  USING (client_id = app_client_id()) WITH CHECK (client_id = app_client_id());

CREATE POLICY push_subs_staff          ON push_subscriptions FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY push_subs_client         ON push_subscriptions FOR ALL
  USING (client_id = app_client_id()) WITH CHECK (client_id = app_client_id());
