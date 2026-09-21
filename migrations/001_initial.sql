CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  network text NOT NULL,
  token_name text NOT NULL,
  token_symbol text NOT NULL,
  total_supply numeric NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  logo_url text,
  contract_address text,
  deployment_tx_hash text,
  payment_tx_hash text,
  status text NOT NULL CHECK (status IN ('pending_payment','payment_confirmed','deploying','success','failed','payment_cancelled','deployment_cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tokens_status_idx ON tokens(status);
CREATE INDEX IF NOT EXISTS tokens_created_idx ON tokens(created_at DESC);
CREATE INDEX IF NOT EXISTS tokens_wallet_idx ON tokens(wallet_address);

