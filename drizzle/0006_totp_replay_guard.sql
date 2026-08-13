-- ---------------------------------------------------------------------------
-- Replay defence for TOTP.
--
-- A time-based code stays arithmetically valid for its whole 30-second window
-- (and, with the drift tolerance every implementation needs, the adjacent
-- windows too). Without a record of which step was last accepted, a code
-- observed over someone's shoulder or lifted from a phishing page can be used
-- a second time inside that window.
--
-- Storing the last accepted step and refusing anything at or below it closes
-- that: a code is good exactly once. Nullable because an account that has never
-- completed a TOTP challenge has no last step, and 0 would wrongly reject codes
-- from the epoch-adjacent steps in tests.
-- ---------------------------------------------------------------------------

ALTER TABLE clients ADD COLUMN IF NOT EXISTS totp_last_step bigint;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS totp_last_step bigint;
