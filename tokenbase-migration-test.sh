#!/bin/bash
# Proves migration 002 is safe to run on a database that already has data.
#
# Starts a throwaway PostgreSQL, applies 001, writes rows using the column names
# that existed before the rename, applies 002, then checks that every value came
# through intact. Also checks that running 002 twice is a no-op and that it works
# on an empty database.
#
# Run on the host that has docker (not inside the node container):
#   bash tokenbase-migration-test.sh
set -uo pipefail

# Default to the tree this script lives in, so it works from a clone as well as
# from the deployment sandbox. Override with APP=/some/tree.
APP="${APP:-$(cd "$(dirname "$0")" && pwd)}"
NAME="tb-migtest-$$"
FAILED=0

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    say "PASS  $label"
  else
    say "FAIL  $label  (expected '$expected', got '$actual')"
    FAILED=1
  fi
}

say "== starting a throwaway postgres =="
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=tc \
  postgres:16-alpine >/dev/null || { say "could not start postgres"; exit 1; }

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d tc >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d tc >/dev/null 2>&1 || { say "postgres never became ready"; exit 1; }

q() { docker exec -i "$NAME" psql -U postgres -d tc -v ON_ERROR_STOP=1 -tAc "$1" 2>&1; }
apply() { docker exec -i "$NAME" psql -U postgres -d tc -v ON_ERROR_STOP=1 -q -f - 2>&1; }

# ---------------------------------------------------------------------------
say
say "== scenario 1: a database that already has data (the production case) =="

apply < "$APP/migrations/001_initial.sql" >/dev/null
check "001 applied, tokens table exists" "t" "$(q "SELECT to_regclass('public.tokens') IS NOT NULL")"

# Rows written the way the old application wrote them: old column names, and two
# tokens for the same wallet, which is the relationship the product needs.
q "INSERT INTO tokens (wallet_address, network, token_name, token_symbol, total_supply, decimals, contract_address, deployment_tx_hash, status) VALUES
     ('0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA','Base Sepolia','Token One','ONE','1000',18,'0x1111111111111111111111111111111111111111','0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','success'),
     ('0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA','Base Sepolia','Token Two','TWO','2000',6,'0x2222222222222222222222222222222222222222','0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','success'),
     ('0x1111111111111111111111111111111111111111','Base Sepolia','Token Three','THREE','3000',0,NULL,NULL,'deploying');" >/dev/null

BEFORE_COUNT=$(q "SELECT count(*) FROM tokens")
BEFORE_ONE=$(q "SELECT contract_address FROM tokens WHERE token_symbol='ONE'")
BEFORE_TX=$(q "SELECT deployment_tx_hash FROM tokens WHERE token_symbol='ONE'")
BEFORE_DECIMALS_ZERO=$(q "SELECT decimals FROM tokens WHERE token_symbol='THREE'")
BEFORE_WALLET_A=$(q "SELECT count(*) FROM tokens WHERE wallet_address='0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA'")
check "3 rows seeded" "3" "$BEFORE_COUNT"
check "wallet A owns 2 tokens before migration" "2" "$BEFORE_WALLET_A"

say
say "-- applying 002 --"
OUT=$(apply < "$APP/migrations/002_token_records.sql")
RC=$?
[ -n "$OUT" ] && printf '%s\n' "$OUT" | sed 's/^/      /'
check "002 exits cleanly" "0" "$RC"

say
say "-- data after the rename --"
check "row count unchanged"              "$BEFORE_COUNT" "$(q "SELECT count(*) FROM tokens")"
check "token address survived"           "$BEFORE_ONE" "$(q "SELECT token_contract_address FROM tokens WHERE token_symbol='ONE'")"
check "transaction hash survived"        "$BEFORE_TX" "$(q "SELECT transaction_hash FROM tokens WHERE token_symbol='ONE'")"
check "decimals = 0 survived"            "$BEFORE_DECIMALS_ZERO" "$(q "SELECT decimals FROM tokens WHERE token_symbol='THREE'")"
check "wallet A still owns 2 tokens"     "2" "$(q "SELECT count(*) FROM tokens WHERE wallet_address='0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA'")"
# One wallet owning several tokens is the designed relationship. Exactly one
# wallet in the seed data has more than one, so the count of such wallets is 1.
check "one wallet can own many tokens"   "1" "$(q "SELECT count(*) FROM (SELECT wallet_address FROM tokens GROUP BY wallet_address HAVING count(*) > 1) s")"
check "old column contract_address gone" "f" "$(q "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tokens' AND column_name='contract_address')")"
check "new column token_contract_address" "t" "$(q "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tokens' AND column_name='token_contract_address')")"
check "old column deployment_tx_hash gone" "f" "$(q "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tokens' AND column_name='deployment_tx_hash')")"
check "new column transaction_hash"      "t" "$(q "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tokens' AND column_name='transaction_hash')")"
check "payment_tx_hash kept"             "t" "$(q "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tokens' AND column_name='payment_tx_hash')")"
check "chain_verified added, defaults false" "3" "$(q "SELECT count(*) FROM tokens WHERE chain_verified = false")"
check "wallet index for lookups exists"  "t" "$(q "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='tokens' AND indexname='tokens_wallet_lower_idx')")"
check "contract index exists"            "t" "$(q "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='tokens' AND indexname='tokens_token_contract_idx')")"

say
say "-- re-running 002 (must be a no-op) --"
OUT2=$(apply < "$APP/migrations/002_token_records.sql")
RC2=$?
check "second run exits cleanly" "0" "$RC2"
check "row count still 3"        "3" "$(q "SELECT count(*) FROM tokens")"
check "values still intact"      "$BEFORE_ONE" "$(q "SELECT token_contract_address FROM tokens WHERE token_symbol='ONE'")"

# ---------------------------------------------------------------------------
say
say "== scenario 2: a fresh database =="
docker exec -i "$NAME" psql -U postgres -d tc -q -c "DROP TABLE IF EXISTS tokens;" >/dev/null 2>&1

apply < "$APP/migrations/001_initial.sql" >/dev/null
apply < "$APP/migrations/002_token_records.sql" >/dev/null
check "fresh install ends with the new columns" "t" "$(q "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tokens' AND column_name='token_contract_address')")"
q "INSERT INTO tokens (wallet_address, network, token_name, token_symbol, total_supply, decimals, status) VALUES ('0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA','Base Sepolia','T','T','1',18,'deploying');" >/dev/null
check "fresh install accepts a row"              "1" "$(q "SELECT count(*) FROM tokens")"
check "chain_verified defaults false on insert"  "t" "$(q "SELECT chain_verified = false FROM tokens LIMIT 1")"

# ---------------------------------------------------------------------------
say
if [ "$FAILED" = "1" ]; then
  say "RESULT: MIGRATION TEST FAILED"
  exit 1
fi
say "RESULT: MIGRATION TEST PASSED — no data lost, re-runnable, works on a fresh database"
