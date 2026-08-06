-- ─────────────────────────────────────────────────────────────────────────────
-- UWA Portal — row-level security
--
-- Threat model this closes: an authorization bug anywhere in the application
-- (a missing WHERE clause, a route that forgets to check ownership, an IDOR in
-- a hand-written query) must NOT be able to leak one client's file to another.
-- Ownership is therefore enforced by the database, not by application code.
--
-- How it works
-- ------------
-- Every request opens a transaction and sets two local settings:
--
--     SET LOCAL app.actor_type = 'client' | 'broker' | 'agent'
--     SET LOCAL app.client_id  = '<uuid>'          -- clients only
--
-- The policies below read those settings. `SET LOCAL` is scoped to the
-- transaction, so a pooled connection cannot leak identity between requests —
-- this is why src/db/index.ts refuses to run a query outside a transaction.
--
-- Critical detail: the app role must NOT own these tables and must NOT be a
-- superuser, because Postgres exempts both from RLS. Run this file as the
-- owner; run the application as uwa_app.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Application role ─────────────────────────────────────────────────────────
-- Created only if absent so this migration is safe to re-run. Set the password
-- out of band (ALTER ROLE ... PASSWORD) — never commit it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uwa_app') THEN
    CREATE ROLE uwa_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO uwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uwa_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uwa_app;

-- Belt and braces: even if uwa_app somehow becomes an owner later, FORCE keeps
-- RLS applied.
ALTER TABLE clients              ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients              FORCE ROW LEVEL SECURITY;
ALTER TABLE client_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_stage_history FORCE ROW LEVEL SECURITY;
ALTER TABLE document_requests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requests    FORCE ROW LEVEL SECURITY;
ALTER TABLE documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents            FORCE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs           FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            FORCE ROW LEVEL SECURITY;

-- ── Helper functions ─────────────────────────────────────────────────────────
-- `true` as the second argument to current_setting() makes it return NULL
-- instead of raising when the setting is absent — so a connection that forgot
-- to identify itself sees nothing rather than erroring in a confusing way.

CREATE OR REPLACE FUNCTION app_actor_type() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT current_setting('app.actor_type', true) $$;

CREATE OR REPLACE FUNCTION app_client_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$
  SELECT NULLIF(current_setting('app.client_id', true), '')::uuid
$$;

-- Broker and agent contexts are server-side only; a client session can never
-- set app.actor_type to anything but 'client' because the value is written by
-- src/db/index.ts from the verified session, never from user input.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT app_actor_type() IN ('broker', 'agent', 'system') $$;

-- ── Policies ─────────────────────────────────────────────────────────────────
-- Pattern for every client-scoped table:
--   staff  → full access
--   client → only rows whose client_id matches the session's client
--   anyone else (no settings) → nothing

-- clients: a client may read and update only their own row.
CREATE POLICY clients_staff_all ON clients
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY clients_self_read ON clients
  FOR SELECT USING (id = app_client_id());

CREATE POLICY clients_self_update ON clients
  FOR UPDATE USING (id = app_client_id())
  WITH CHECK (id = app_client_id());

-- Stage history: clients read their own timeline; only staff can write it.
-- This is what makes "each stage is locked until I manually advance them"
-- true at the storage layer, not just in the UI.
CREATE POLICY stage_history_staff_all ON client_stage_history
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY stage_history_client_read ON client_stage_history
  FOR SELECT USING (client_id = app_client_id());

-- Document requests: clients read their checklist; only staff change status.
CREATE POLICY doc_requests_staff_all ON document_requests
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY doc_requests_client_read ON document_requests
  FOR SELECT USING (client_id = app_client_id());

-- Documents: clients read their own and may insert their own uploads.
-- They may NOT update (that would let a client mark their own file approved).
CREATE POLICY documents_staff_all ON documents
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY documents_client_read ON documents
  FOR SELECT USING (client_id = app_client_id());

CREATE POLICY documents_client_insert ON documents
  FOR INSERT WITH CHECK (
    client_id = app_client_id()
    AND uploaded_by = 'client'
    AND status = 'in_review'
  );

-- Messages: clients read their own thread and may post as themselves only.
-- The WITH CHECK on sender_type is what stops a client forging a message that
-- appears to come from the broker.
CREATE POLICY messages_staff_all ON messages
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

CREATE POLICY messages_client_read ON messages
  FOR SELECT USING (client_id = app_client_id());

CREATE POLICY messages_client_insert ON messages
  FOR INSERT WITH CHECK (
    client_id = app_client_id() AND sender_type = 'client'
  );

CREATE POLICY messages_client_mark_read ON messages
  FOR UPDATE USING (client_id = app_client_id())
  WITH CHECK (client_id = app_client_id());

-- Agent runs: internal. Clients never see raw skill output — the broker
-- decides what is surfaced.
CREATE POLICY agent_runs_staff_all ON agent_runs
  FOR ALL USING (app_is_staff()) WITH CHECK (app_is_staff());

-- Audit log: append-only from the app's perspective; staff read.
CREATE POLICY audit_staff_read ON audit_log
  FOR SELECT USING (app_is_staff());

CREATE POLICY audit_insert_any ON audit_log
  FOR INSERT WITH CHECK (true);

-- ── Unrestricted tables ──────────────────────────────────────────────────────
-- sessions, brokers, pipeline_stages and inbound_emails are deliberately NOT
-- under RLS: they are only ever touched by server-side code running before a
-- client identity exists (session lookup happens before we know who the user
-- is). Access to them is not reachable from a client-scoped request path.
REVOKE ALL ON brokers FROM uwa_app;
GRANT SELECT, UPDATE ON brokers TO uwa_app;
