-- ---------------------------------------------------------------------------
-- Close the row-level-security gaps found by auditing pg_tables.
--
-- Postgres grants are unconditional in the absence of a policy. Any table the
-- application role can reach but that has no RLS enabled is readable by EVERY
-- actor the app connects as, including a signed-in borrower. Auditing
-- `pg_tables WHERE NOT rowsecurity` after adding 0004 turned up five such
-- tables. Two of them mattered a great deal:
--
--   brokers   — a client-actor connection could SELECT password_hash (and,
--               after 0003, totp_secret). Not reachable through any route
--               today, but it means one SQL slip in a client-facing query
--               turns into an offline crack of the broker's password and then
--               full administrative access.
--
--   sessions  — a client-actor connection could read every row: who is signed
--               in, from where, and the SHA-256 of their session token. The
--               hash is not directly forgeable, but this is a list of live
--               credentials and borrowers have no business holding it.
--
-- The other three (compliance_templates, compliance_template_items,
-- referral_sources) are brokerage configuration that 0003 granted DML on
-- without a policy.
--
-- Every one of these is staff-only, and every code path that touches them
-- already runs under `asSystem` or `asBroker` — verified before writing this,
-- so the policies below change no behaviour. `tests/rls.test.ts` now asserts
-- that no granted table is left without RLS, so this class of gap fails the
-- suite rather than waiting for the next audit.
--
-- pipeline_stages is deliberately left open: it is public reference data (the
-- six stage names) with nothing sensitive in it, and the client dashboard
-- reads it directly.
-- ---------------------------------------------------------------------------

-- ── Brokerage configuration ──────────────────────────────────────────────────

ALTER TABLE compliance_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_templates      FORCE  ROW LEVEL SECURITY;
ALTER TABLE compliance_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_template_items FORCE  ROW LEVEL SECURITY;
ALTER TABLE referral_sources          ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_sources          FORCE  ROW LEVEL SECURITY;

CREATE POLICY compliance_templates_staff ON compliance_templates
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY compliance_template_items_staff ON compliance_template_items
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY referral_sources_staff ON referral_sources
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ── Credentials ──────────────────────────────────────────────────────────────
-- Note FORCE: without it the table owner bypasses its own policy, and the
-- migration role owns these tables.

ALTER TABLE brokers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokers  FORCE  ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE  ROW LEVEL SECURITY;

-- Login, session lookup and the dashboard's broker-name read all run under the
-- system actor, which app_is_staff() covers. A client actor now sees nothing.
CREATE POLICY brokers_staff ON brokers
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY sessions_staff ON sessions
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ── Inbound mail ─────────────────────────────────────────────────────────────
-- Raw inbound messages, including senders who never became clients.

ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_emails FORCE  ROW LEVEL SECURITY;

CREATE POLICY inbound_emails_staff ON inbound_emails
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

-- ── The migration ledger ─────────────────────────────────────────────────────
-- Root cause of the above: 0002 says
--
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uwa_app;
--
-- and `ALL TABLES` swept up `_migrations`, which the runner creates before any
-- migration executes. The application never touches it, and DELETE on it is
-- genuinely dangerous — dropping a row makes that migration run a second time,
-- and 0002 re-run would attempt to recreate roles and policies.
--
-- Revoked rather than given a policy: the correct privilege here is none.
REVOKE ALL ON _migrations FROM uwa_app;
