-- ─────────────────────────────────────────────────────────────────────────────
-- UWA Portal — deals, intake applications, borrower financials, compliance
--
-- The structural change here: a client is a PERSON, a deal is an APPLICATION,
-- and one person can have several. Until now `clients.stage_key` meant a client
-- had exactly one application forever, which breaks the moment someone
-- refinances after a purchase — the single most common repeat-business case in
-- a brokerage.
--
-- Stage now lives on the deal. `clients.stage_key` is left in place and kept in
-- sync by a trigger, so nothing that reads it breaks mid-migration; it is
-- marked deprecated and can be dropped once every read has moved.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Deals ────────────────────────────────────────────────────────────────────

CREATE TYPE deal_status AS ENUM ('active', 'archived', 'funded', 'lost');

CREATE TABLE deals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The primary borrower. Co-borrowers live in deal_borrowers.
  client_id             uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  reference             text NOT NULL UNIQUE,
  deal_type             text NOT NULL DEFAULT 'purchase',
  stage_key             text NOT NULL DEFAULT 'inquiry' REFERENCES pipeline_stages(key),
  status                deal_status NOT NULL DEFAULT 'active',
  assigned_to           uuid REFERENCES brokers(id) ON DELETE SET NULL,

  -- Application lock. Once underwriting begins the borrower can still upload
  -- documents but cannot alter the application answers underneath a lender.
  locked_at             timestamptz,
  locked_by             uuid REFERENCES brokers(id) ON DELETE SET NULL,

  -- Property
  property_address      text,
  property_city         text,
  property_province     text,
  property_postal_code  text,
  property_type         text,
  occupancy             text,
  purchase_price        numeric(14, 2),
  property_value        numeric(14, 2),

  -- Mortgage terms
  down_payment          numeric(14, 2),
  mortgage_amount       numeric(14, 2),
  interest_rate         numeric(6, 3),
  amortization_years    integer,
  term_years            integer,
  payment_frequency     text DEFAULT 'monthly',

  -- Carrying costs — the inputs GDS needs beyond the mortgage payment itself.
  annual_property_tax   numeric(12, 2),
  monthly_heat          numeric(10, 2),
  monthly_condo_fees    numeric(10, 2),

  -- Existing mortgage, for refinance and renewal files
  existing_balance      numeric(14, 2),
  existing_lender       text,
  maturity_date         date,

  -- Lead attribution
  referral_code         text,
  lead_source           text,

  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  funded_at             timestamptz,
  archived_at           timestamptz
);

CREATE INDEX deals_client_idx ON deals (client_id, created_at DESC);
CREATE INDEX deals_stage_idx ON deals (stage_key) WHERE status = 'active';
CREATE INDEX deals_assigned_idx ON deals (assigned_to) WHERE status = 'active';
CREATE INDEX deals_maturity_idx ON deals (maturity_date) WHERE maturity_date IS NOT NULL;

-- Human-readable reference: UWA-2026-0001. Brokers quote these on the phone,
-- so a UUID is not an acceptable substitute.
CREATE SEQUENCE deal_reference_seq;

CREATE OR REPLACE FUNCTION next_deal_reference() RETURNS text
  LANGUAGE sql AS
$$
  SELECT 'UWA-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('deal_reference_seq')::text, 4, '0')
$$;

-- ── Co-borrowers ─────────────────────────────────────────────────────────────
-- A join table rather than columns on `deals`, because the number of borrowers
-- is genuinely variable and each one is a real person with their own login.

CREATE TABLE deal_borrowers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'co_borrower',
  invited_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  UNIQUE (deal_id, client_id)
);

CREATE INDEX deal_borrowers_client_idx ON deal_borrowers (client_id);

-- ── Borrower financials ──────────────────────────────────────────────────────
-- Scoped to (deal, client): the same person's income is restated per
-- application, because it changes between a purchase in 2024 and a refinance
-- in 2026 and each file must keep what was actually declared at the time.

CREATE TABLE borrower_incomes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  employment_type   text NOT NULL DEFAULT 'salaried',
  employer_name     text,
  occupation        text,
  years_at_job      numeric(5, 2),
  annual_income     numeric(14, 2) NOT NULL DEFAULT 0,
  -- Self-employed and commission income is usually averaged over two years.
  prior_year_income numeric(14, 2),
  is_primary        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX incomes_deal_idx ON borrower_incomes (deal_id);

CREATE TABLE borrower_liabilities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  client_id         uuid REFERENCES clients(id) ON DELETE CASCADE,
  liability_type    text NOT NULL DEFAULT 'other',
  description       text,
  balance           numeric(14, 2) NOT NULL DEFAULT 0,
  monthly_payment   numeric(12, 2) NOT NULL DEFAULT 0,
  -- A liability being paid out on closing does not count against TDS.
  include_in_tds    boolean NOT NULL DEFAULT true,
  payout_on_closing boolean NOT NULL DEFAULT false,
  source            actor_type NOT NULL DEFAULT 'client',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX liabilities_deal_idx ON borrower_liabilities (deal_id);

-- ── Intake applications ──────────────────────────────────────────────────────
-- The public form's submission. Answers are kept verbatim as JSON alongside the
-- structured columns they were mapped into, so a question added to the form
-- later never silently loses the answers already collected.

CREATE TABLE applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id        uuid REFERENCES deals(id) ON DELETE CASCADE,
  client_id      uuid REFERENCES clients(id) ON DELETE SET NULL,
  tier           text NOT NULL DEFAULT 'short',
  locale         text NOT NULL DEFAULT 'en',
  status         text NOT NULL DEFAULT 'submitted',
  answers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  referral_code  text,
  ip_address     text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz
);

CREATE INDEX applications_deal_idx ON applications (deal_id);
CREATE INDEX applications_referral_idx ON applications (referral_code);

-- ── Referral links ───────────────────────────────────────────────────────────

CREATE TABLE referral_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id   uuid REFERENCES brokers(id) ON DELETE CASCADE,
  code        text NOT NULL UNIQUE,
  label       text NOT NULL,
  medium      text NOT NULL DEFAULT 'other',
  is_active   boolean NOT NULL DEFAULT true,
  visits      integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Compliance ───────────────────────────────────────────────────────────────
-- Broker-defined checklists. Deliberately NOT automated screening: real
-- FINTRAC/PEP screening needs a licensed sanctions-list vendor, and a homemade
-- version that says "no match" would be worse than having nothing.

CREATE TABLE compliance_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id   uuid REFERENCES brokers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  deal_type   text,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compliance_template_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid NOT NULL REFERENCES compliance_templates(id) ON DELETE CASCADE,
  label             text NOT NULL,
  description       text,
  requires_document boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0
);

CREATE TABLE deal_compliance_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  label             text NOT NULL,
  description       text,
  requires_document boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'pending',
  document_id       uuid REFERENCES documents(id) ON DELETE SET NULL,
  note              text,
  completed_by      uuid REFERENCES brokers(id) ON DELETE SET NULL,
  completed_at      timestamptz,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX compliance_deal_idx ON deal_compliance_items (deal_id, sort_order);

-- ── Two-factor authentication ────────────────────────────────────────────────
-- TOTP (authenticator app). Chosen over SMS because it needs no third-party
-- vendor and is not vulnerable to SIM-swap — which matters when the account
-- guards someone's financial documents.

ALTER TABLE clients
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_confirmed_at timestamptz;

ALTER TABLE brokers
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_confirmed_at timestamptz;

-- Single-use recovery codes, stored hashed like any other credential.
CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type  actor_type NOT NULL,
  user_id    uuid NOT NULL,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_type, user_id);

-- A session is only fully authenticated once the second factor is satisfied.
ALTER TABLE sessions
  ADD COLUMN mfa_satisfied boolean NOT NULL DEFAULT true;

-- ── Deal scoping on existing tables ──────────────────────────────────────────

ALTER TABLE documents          ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE document_requests  ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE messages           ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE client_stage_history ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE agent_runs         ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE CASCADE;

CREATE INDEX documents_deal_idx ON documents (deal_id);
CREATE INDEX doc_requests_deal_idx ON document_requests (deal_id);
CREATE INDEX messages_deal_idx ON messages (deal_id, created_at);

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Give every existing client exactly one deal carrying their current stage, and
-- attach their existing documents, requests, messages and history to it.

INSERT INTO deals (client_id, reference, deal_type, stage_key, assigned_to, notes, created_at, updated_at)
SELECT
  c.id,
  next_deal_reference(),
  c.application_type,
  c.stage_key,
  c.broker_id,
  c.notes,
  c.created_at,
  c.updated_at
FROM clients c;

INSERT INTO deal_borrowers (deal_id, client_id, role, accepted_at)
SELECT d.id, d.client_id, 'primary', now() FROM deals d;

UPDATE documents SET deal_id = d.id FROM deals d WHERE documents.client_id = d.client_id;
UPDATE document_requests SET deal_id = d.id FROM deals d WHERE document_requests.client_id = d.client_id;
UPDATE messages SET deal_id = d.id FROM deals d WHERE messages.client_id = d.client_id;
UPDATE client_stage_history SET deal_id = d.id FROM deals d WHERE client_stage_history.client_id = d.client_id;
UPDATE agent_runs SET deal_id = d.id FROM deals d WHERE agent_runs.client_id = d.client_id;

-- ── Keep clients.stage_key in sync ───────────────────────────────────────────
-- Transitional. Existing reads of clients.stage_key keep working while the
-- application moves over to reading it from the deal. Mirrors the most recently
-- updated active deal.

COMMENT ON COLUMN clients.stage_key IS
  'DEPRECATED — mirrors the client''s most recent active deal. Read deals.stage_key instead.';

CREATE OR REPLACE FUNCTION sync_client_stage() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  UPDATE clients c
     SET stage_key = COALESCE((
           SELECT d.stage_key FROM deals d
            WHERE d.client_id = c.id AND d.status = 'active'
            ORDER BY d.updated_at DESC
            LIMIT 1
         ), c.stage_key)
   WHERE c.id = NEW.client_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER deals_sync_client_stage
  AFTER INSERT OR UPDATE OF stage_key, status ON deals
  FOR EACH ROW EXECUTE FUNCTION sync_client_stage();

-- ── Row-level security ───────────────────────────────────────────────────────
-- Same pattern as 0002: staff see everything, a client sees only rows belonging
-- to a deal they are a borrower on. Note the co-borrower case — access is via
-- deal_borrowers membership, not just deals.client_id, otherwise an invited
-- co-borrower could not see the application they were invited to.

ALTER TABLE deals                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals                 FORCE ROW LEVEL SECURITY;
ALTER TABLE deal_borrowers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_borrowers        FORCE ROW LEVEL SECURITY;
ALTER TABLE borrower_incomes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE borrower_incomes      FORCE ROW LEVEL SECURITY;
ALTER TABLE borrower_liabilities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE borrower_liabilities  FORCE ROW LEVEL SECURITY;
ALTER TABLE applications          ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications          FORCE ROW LEVEL SECURITY;
ALTER TABLE deal_compliance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_compliance_items FORCE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes        FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  deals, deal_borrowers, borrower_incomes, borrower_liabilities, applications,
  referral_sources, compliance_templates, compliance_template_items,
  deal_compliance_items, recovery_codes
TO uwa_app;

GRANT USAGE, SELECT ON SEQUENCE deal_reference_seq TO uwa_app;

/**
 * True when the current client is a borrower on this deal.
 * SECURITY DEFINER so the lookup itself is not filtered by the policy that
 * calls it — without it, deal_borrowers' own policy would recurse.
 */
CREATE OR REPLACE FUNCTION app_can_see_deal(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$
  SELECT EXISTS (
    SELECT 1 FROM deal_borrowers db
     WHERE db.deal_id = target AND db.client_id = app_client_id()
  )
$$;

CREATE POLICY deals_staff_all ON deals
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY deals_client_read ON deals
  FOR SELECT USING (app_can_see_deal(id));

CREATE POLICY deal_borrowers_staff_all ON deal_borrowers
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY deal_borrowers_client_read ON deal_borrowers
  FOR SELECT USING (client_id = app_client_id() OR app_can_see_deal(deal_id));

CREATE POLICY incomes_staff_all ON borrower_incomes
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
-- A borrower sees and edits only their OWN income, not a co-borrower's.
CREATE POLICY incomes_client_own ON borrower_incomes
  FOR ALL USING (client_id = app_client_id())
  WITH CHECK (client_id = app_client_id());

CREATE POLICY liabilities_staff_all ON borrower_liabilities
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY liabilities_client_own ON borrower_liabilities
  FOR ALL USING (client_id = app_client_id())
  WITH CHECK (client_id = app_client_id());

CREATE POLICY applications_staff_all ON applications
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());
CREATE POLICY applications_client_read ON applications
  FOR SELECT USING (client_id = app_client_id());

-- Compliance is internal to the brokerage; clients never see it.
CREATE POLICY compliance_staff_all ON deal_compliance_items
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

-- Recovery codes are consumed during login, before an actor identity exists,
-- so they are reachable by the system actor only.
CREATE POLICY recovery_codes_staff_all ON recovery_codes
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

-- Existing per-client policies already cover documents, requests, messages and
-- stage history via client_id, which the backfill kept consistent with deal_id.
