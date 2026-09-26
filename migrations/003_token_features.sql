-- 003_token_features.sql
--
-- Records which optional features each token was created with.
--
-- Safety rules, the same ones 002 follows:
--   * ADD COLUMN IF NOT EXISTS, so running this twice is a no-op rather than an
--     error.
--   * Existing rows default to false, which is the honest answer for them: they
--     were created before these features existed, so they have none of them.
--   * Nothing is dropped and nothing is deleted.
--
-- These columns are a record, never a control. Nothing in the application reads
-- them to decide what a token may do — that is settled by the deployed contract,
-- whose `creator` is the only address holding mint or pause power. A row here
-- saying `mintable = false` cannot stop a token that has `mint`, and a row saying
-- `true` cannot grant one that does not.

BEGIN;

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS burnable boolean NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mintable boolean NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pausable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tokens.burnable IS
  'Whether the token was deployed with a burn function. Display only; the deployed contract decides what a token can do.';
COMMENT ON COLUMN tokens.mintable IS
  'Whether the token was deployed with a creator-only mint function. Display only.';
COMMENT ON COLUMN tokens.pausable IS
  'Whether the token was deployed with a creator-only pause function. Display only.';

-- The admin view groups tokens by which powers they carry, so one index over the
-- three flags serves that filter without a sequential scan.
CREATE INDEX IF NOT EXISTS tokens_features_idx ON tokens (burnable, mintable, pausable);

COMMIT;
