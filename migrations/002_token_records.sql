-- 002_token_records.sql
--
-- Brings the creation-record table in line with the record fields the product
-- talks about, and adds the bookkeeping needed to tell a verified record from an
-- unverified claim.
--
-- Safety rules this migration follows:
--   * RENAME COLUMN moves the data, it does not drop it. Every row written by
--     001_initial.sql keeps its values under the new name.
--   * Nothing is dropped and nothing is deleted.
--   * Every statement is guarded, so running this twice is a no-op rather than
--     an error. Migrations that cannot be re-run are a trap during an incident.
--
-- Column naming:
--   contract_address   -> token_contract_address
--   deployment_tx_hash -> transaction_hash
--   payment_tx_hash    stays: it is a different transaction (the optional
--                      service-fee leg) and must not be confused with the token
--                      creation transaction.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Rename the two columns, preserving their data.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tokens'
      AND column_name = 'contract_address'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tokens'
      AND column_name = 'token_contract_address'
  ) THEN
    ALTER TABLE tokens RENAME COLUMN contract_address TO token_contract_address;
    RAISE NOTICE 'renamed contract_address -> token_contract_address';
  ELSE
    RAISE NOTICE 'contract_address rename skipped (already applied or source missing)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tokens'
      AND column_name = 'deployment_tx_hash'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tokens'
      AND column_name = 'transaction_hash'
  ) THEN
    ALTER TABLE tokens RENAME COLUMN deployment_tx_hash TO transaction_hash;
    RAISE NOTICE 'renamed deployment_tx_hash -> transaction_hash';
  ELSE
    RAISE NOTICE 'deployment_tx_hash rename skipped (already applied or source missing)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Chain-verification bookkeeping.
--
-- A record only earns chain_verified = true when the server has independently
-- confirmed, over RPC, that the transaction succeeded and that the token address
-- in the record is the one the factory actually emitted. Rows written before
-- this migration default to false, which is the honest answer for them: nobody
-- checked.
-- ---------------------------------------------------------------------------

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS chain_verified boolean NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS verification_note text;

COMMENT ON COLUMN tokens.chain_verified IS
  'True only after the server confirmed the receipt and the TokenCreated address over RPC.';
COMMENT ON COLUMN tokens.verification_note IS
  'Why verification did not pass, or why it could not be attempted. Never a substitute for chain_verified.';

-- ---------------------------------------------------------------------------
-- 3. Indexes for the admin queries.
--
-- Addresses and symbols arrive in mixed case from users, so the search indexes
-- are on lower()/upper() to match the case-insensitive lookups the API performs.
-- The existing tokens_wallet_idx stays; it still serves exact-match queries.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS tokens_token_contract_idx ON tokens (token_contract_address);
CREATE INDEX IF NOT EXISTS tokens_tx_hash_idx ON tokens (transaction_hash);
CREATE INDEX IF NOT EXISTS tokens_wallet_lower_idx ON tokens (lower(wallet_address));
CREATE INDEX IF NOT EXISTS tokens_symbol_upper_idx ON tokens (upper(token_symbol));
CREATE INDEX IF NOT EXISTS tokens_name_lower_idx ON tokens (lower(token_name));

-- A wallet owning several tokens is a normal case, not an exception, so there is
-- deliberately no unique constraint on wallet_address. This index exists purely
-- to keep "every token this wallet created" fast.

COMMIT;
