-- ─────────────────────────────────────────────────────────────────────────────
-- UWA Portal — initial schema
--
-- Run as the OWNER role (DATABASE_MIGRATION_URL). The application connects as
-- a separate, unprivileged role (uwa_app) so that row-level security is
-- actually enforced against it — Postgres exempts table owners from RLS by
-- default, which is the single most common way an RLS setup silently does
-- nothing.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE actor_type AS ENUM ('client', 'broker', 'agent', 'system');

CREATE TYPE client_status AS ENUM ('invited', 'active', 'suspended', 'archived');

-- Mirrors Finmo's four-state document model, which is the clearest one in the
-- market: the broker always knows which pile a file is in.
CREATE TYPE document_status AS ENUM (
  'requested',        -- asked for, nothing uploaded yet
  'in_review',        -- client uploaded, awaiting broker review
  'needs_attention',  -- rejected: wrong doc, unreadable, expired
  'approved'          -- broker accepted it
);

CREATE TYPE agent_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- ── Brokers ──────────────────────────────────────────────────────────────────
-- Deliberately a table rather than a single hardcoded admin: brokerages add
-- staff, and an audit trail needs a real actor id.

CREATE TABLE brokers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  full_name      text NOT NULL,
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- ── Pipeline stages ──────────────────────────────────────────────────────────
-- Ordered reference data. Stages are advanced manually by the broker only;
-- nothing in the application logic auto-advances a client.

CREATE TABLE pipeline_stages (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL,
  sort_order  integer NOT NULL UNIQUE
);

INSERT INTO pipeline_stages (key, label, description, sort_order) VALUES
  ('inquiry',              'Inquiry',              'We have your enquiry and your file is open.',                          1),
  ('documents_received',   'Documents Received',   'Your supporting documents are in and being organised.',                2),
  ('under_review',         'Under Review',         'Your file is with underwriting for assessment.',                       3),
  ('conditional_approval', 'Conditional Approval', 'Approved subject to conditions — we may ask for a few more items.',    4),
  ('final_approval',       'Final Approval',       'All conditions satisfied. Your mortgage is formally approved.',        5),
  ('funded',               'Funded',               'Funds have been advanced. Congratulations!',                           6);

-- ── Clients ──────────────────────────────────────────────────────────────────

CREATE TABLE clients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL,
  full_name            text NOT NULL,
  username             text NOT NULL,
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  status               client_status NOT NULL DEFAULT 'invited',
  application_type     text NOT NULL DEFAULT 'purchase',
  stage_key            text NOT NULL DEFAULT 'inquiry' REFERENCES pipeline_stages(key),
  drive_folder_id      text,
  phone                text,
  notes                text,
  broker_id            uuid REFERENCES brokers(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz
);

-- Case-insensitive uniqueness without requiring the citext extension.
CREATE UNIQUE INDEX clients_email_key ON clients (lower(email));
CREATE UNIQUE INDEX clients_username_key ON clients (lower(username));
CREATE INDEX clients_stage_idx ON clients (stage_key);
CREATE INDEX clients_broker_idx ON clients (broker_id);

CREATE UNIQUE INDEX brokers_email_key ON brokers (lower(email));

-- ── Stage history ────────────────────────────────────────────────────────────
-- Append-only. Gives the client a dated timeline and the broker an audit trail
-- of who moved the file and when.

CREATE TABLE client_stage_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stage_key     text NOT NULL REFERENCES pipeline_stages(key),
  note          text,
  advanced_by   uuid REFERENCES brokers(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stage_history_client_idx ON client_stage_history (client_id, created_at DESC);

-- ── Document requests (the checklist) ────────────────────────────────────────
-- One row per item the broker (or the agent) needs from the client. Uploads
-- attach to a request; a request with no upload is simply outstanding.

CREATE TABLE document_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label         text NOT NULL,
  description   text,
  category      text NOT NULL DEFAULT 'other',
  is_required   boolean NOT NULL DEFAULT true,
  status        document_status NOT NULL DEFAULT 'requested',
  review_note   text,
  created_by    actor_type NOT NULL DEFAULT 'broker',
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doc_requests_client_idx ON document_requests (client_id, sort_order);

-- ── Documents (uploaded files) ───────────────────────────────────────────────
-- The bytes live in Google Drive. This table stores only metadata plus the
-- Drive file id. There is no public URL column by design — downloads are
-- proxied through an authenticated route that re-checks ownership.

CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  request_id          uuid REFERENCES document_requests(id) ON DELETE SET NULL,
  drive_file_id       text NOT NULL,
  file_name           text NOT NULL,
  mime_type           text NOT NULL,
  size_bytes          bigint NOT NULL,
  checksum_sha256     text,
  status              document_status NOT NULL DEFAULT 'in_review',
  review_note         text,
  classified_as       text,
  classification_meta jsonb,
  uploaded_by         actor_type NOT NULL DEFAULT 'client',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at         timestamptz
);

CREATE INDEX documents_client_idx ON documents (client_id, created_at DESC);
CREATE INDEX documents_request_idx ON documents (request_id);
CREATE UNIQUE INDEX documents_drive_file_key ON documents (drive_file_id);

-- ── Messages (persistent thread, one per client) ─────────────────────────────

CREATE TABLE messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sender_type  actor_type NOT NULL,
  sender_id    uuid,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz
);

CREATE INDEX messages_client_idx ON messages (client_id, created_at);
CREATE INDEX messages_unread_idx ON messages (client_id) WHERE read_at IS NULL;

-- ── Sessions ─────────────────────────────────────────────────────────────────
-- Only the SHA-256 of the session token is stored. A database compromise
-- therefore does not yield usable session cookies.

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  user_type    actor_type NOT NULL,
  user_id      uuid NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ip_address   text,
  user_agent   text
);

CREATE INDEX sessions_user_idx ON sessions (user_type, user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ── Agent runs ───────────────────────────────────────────────────────────────
-- Every skill invocation is recorded: input, output, latency, token usage.
-- This is the integration seam described in docs/AGENT_SKILLS.md.

CREATE TABLE agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  skill_key     text NOT NULL,
  trigger       text NOT NULL,
  status        agent_run_status NOT NULL DEFAULT 'queued',
  input         jsonb NOT NULL DEFAULT '{}'::jsonb,
  output        jsonb,
  error         text,
  input_tokens  integer,
  output_tokens integer,
  duration_ms   integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz
);

CREATE INDEX agent_runs_client_idx ON agent_runs (client_id, created_at DESC);
CREATE INDEX agent_runs_queue_idx ON agent_runs (status, created_at) WHERE status = 'queued';

-- ── Inbound email ledger ─────────────────────────────────────────────────────
-- Dedupes IMAP delivery. A retried or re-fetched message is a no-op.

CREATE TABLE inbound_emails (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     text NOT NULL UNIQUE,
  from_email     text NOT NULL,
  from_name      text,
  subject        text,
  body_preview   text,
  client_id      uuid REFERENCES clients(id) ON DELETE SET NULL,
  outcome        text NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);

-- ── Audit log ────────────────────────────────────────────────────────────────

CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type   actor_type NOT NULL,
  actor_id     uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    uuid,
  client_id    uuid REFERENCES clients(id) ON DELETE SET NULL,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_client_idx ON audit_log (client_id, created_at DESC);
CREATE INDEX audit_actor_idx ON audit_log (actor_type, actor_id, created_at DESC);
