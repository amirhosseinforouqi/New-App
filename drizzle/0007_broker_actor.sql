-- ---------------------------------------------------------------------------
-- Let an OWNER invite a team member, without letting the application mint
-- administrators.
--
-- 0002 revoked INSERT on `brokers` from the application role on purpose: an
-- application compromise must not be able to create itself an admin account.
-- That control is worth keeping. But a brokerage owner genuinely does need to
-- add an agent, and routing that through a shell script is the kind of friction
-- that ends with someone sharing a login.
--
-- The resolution is a narrower key rather than a wider grant. `withActor`
-- already receives the acting broker's id and, until now, discarded it. It is
-- now published as `app.broker_id`, and INSERT on `brokers` is permitted only
-- when the acting actor is a broker whose own row says `role = 'owner'`.
--
-- What that buys, precisely:
--
--   A client session still cannot create a broker — app_actor_type is 'client'.
--   A SYSTEM session cannot either, which matters because session lookup, the
--   inbound mail worker and the public intake all run as system. The blast
--   radius of the most widely-reachable actor is unchanged.
--   An agent or assistant session cannot: the subquery checks their role.
--   Only a signed-in owner can, and every such insert is audited.
--
-- DELETE is still not granted to anyone. Deactivating a broker sets is_active
-- false; removing the row would orphan the audit trail that points at it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_broker_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.broker_id', true), '')::uuid $$;

/**
 * True when the caller is a broker whose own row grants ownership.
 *
 * SECURITY DEFINER so the lookup is not itself filtered by the policy on
 * `brokers` that calls it — without it this recurses.
 */
CREATE OR REPLACE FUNCTION app_is_owner() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$
  SELECT app_actor_type() = 'broker'
     AND EXISTS (
       SELECT 1 FROM brokers b
        WHERE b.id = app_broker_id() AND b.role = 'owner' AND b.is_active
     )
$$;

GRANT INSERT ON brokers TO uwa_app;

-- Replace the blanket FOR ALL policy from 0005 with per-command ones, so the
-- INSERT path can carry a stricter condition than reads and updates.
DROP POLICY IF EXISTS brokers_staff ON brokers;

CREATE POLICY brokers_staff_read ON brokers
  FOR SELECT USING (app_is_staff());

CREATE POLICY brokers_staff_update ON brokers
  FOR UPDATE USING (app_is_staff()) WITH CHECK (app_is_staff());

-- The narrow one. Note there is no USING clause: INSERT policies only take
-- WITH CHECK, and this is the whole control.
CREATE POLICY brokers_owner_insert ON brokers
  FOR INSERT WITH CHECK (app_is_owner());
