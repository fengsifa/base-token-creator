#!/bin/bash
# End-to-end test of the creation-record path against the live deployment.
#
# Runs on the server. Uses the real API and the real database, and checks the
# things that matter for correctness rather than merely "it returns 200":
#
#   * a record cannot be created without a wallet address
#   * the admin API is unreachable without the admin session
#   * a success claim the chain does not support is REFUSED
#   * a success claim the chain cannot be consulted about is stored as UNVERIFIED
#   * a record cannot be re-pointed at a different token
#   * one wallet can own several records
#
# Test rows are removed at the end; the existing data is left alone.
#
# Run on the host that serves the deployment. Every location is overridable:/n#   BASE=http://127.0.0.1:3000 ENVFILE=./.env.local COMPOSE_DIR=. \
#     bash tokenbase-e2e-records-test.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
ENVFILE="${ENVFILE:-$(cd "$(dirname "$0")" && pwd)/.env.local}"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")" && pwd)}"

SECRET=$(grep -E '^ADMIN_SECRET=' "$ENVFILE" | head -1 | cut -d= -f2-)
WALLET=0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA
WALLET_B=0x1111111111111111111111111111111111111111

# The real factory-deployment transaction: it succeeded, but it is not a token
# creation and emitted no TokenCreated event. Perfect for testing a false claim.
REAL_TX_WITHOUT_TOKEN=0x7c02fd6633d17047837ca89da2f7b7b2702857d392dc05a91a70775a55ec7db6
FAKE_TOKEN=0x000000000000000000000000000000000000dEaD
OTHER_TOKEN=0x000000000000000000000000000000000000bEEF
UNMINED_TX=0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc

FAILED=0
pass()  { printf 'PASS  %s\n' "$*"; }
fail()  { printf 'FAIL  %s\n' "$*"; FAILED=1; }
check() { if [ "$2" = "$3" ]; then pass "$1  ($3)"; else fail "$1  (expected $2, got $3)"; fi; }

jsonfield() {
  python3 -c '
import sys, json
path = sys.argv[1].split(".")
d = json.load(sys.stdin)
for p in path:
    d = d[int(p)] if p.isdigit() else d[p]
print(d)
' "$1" 2>/dev/null
}

# post <path> <json> -> "<status>\n<body>"
req() {
  local method="$1" path="$2" body="$3"; shift 3
  curl -sS -X "$method" -H 'Content-Type: application/json' "$@" \
    --max-time 40 -d "$body" -w '\n%{http_code}' "$BASE$path"
}
status_of() { printf '%s' "$1" | tail -1; }
body_of()   { printf '%s' "$1" | sed '$d'; }

q() { docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T postgres \
        psql -U token_creator -d token_creator -tAc "$1" 2>&1; }

printf '== live deployment ==\n'
check "site is up" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/creator")"
check "records page is up" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/admin/records")"

printf '\n== admin surface is closed by default ==\n'
check "records API without a session" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/api/admin/records")"
check "records API with a wrong cookie" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Cookie: tokenbase_admin=wrong' "$BASE/api/admin/records")"
check "data API without a session" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/api/admin/data")"
check "no public listing of records" "405" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/api/creations")"

printf '\n== a record cannot be created without a wallet address ==\n'
R=$(req POST /api/creations '{"network":"Base Sepolia","token_name":"No Wallet","token_symbol":"NW","total_supply":"1000","decimals":18,"status":"deploying"}')
check "partial create is refused" "400" "$(status_of "$R")"
check "and says which field" "true" "$(body_of "$R" | grep -q 'wallet_address' && echo true || echo false)"

printf '\n== creating a record with the real wallet ==\n'
R=$(req POST /api/creations "{\"wallet_address\":\"$WALLET\",\"network\":\"Base Sepolia\",\"token_name\":\"E2E One\",\"token_symbol\":\"E2EONE\",\"total_supply\":\"1000\",\"decimals\":18,\"status\":\"deploying\"}")
check "create succeeds" "200" "$(status_of "$R")"
ID_ONE=$(body_of "$R" | jsonfield record.id)
[ -n "${ID_ONE:-}" ] && pass "record id returned  (${ID_ONE:0:8}…)" || fail "no record id returned"

printf '\n== a success the chain does not support is refused ==\n'
SUCCESS_BODY="{\"status\":\"success\",\"token_contract_address\":\"$FAKE_TOKEN\",\"transaction_hash\":\"$REAL_TX_WITHOUT_TOKEN\"}"
R=$(req PATCH "/api/creations/$ID_ONE" "$SUCCESS_BODY")
check "claimed success with no TokenCreated event is refused" "409" "$(status_of "$R")"
check "the record was NOT marked success" "deploying" "$(q "SELECT status FROM tokens WHERE id='$ID_ONE'")"
check "and was NOT given a token address" "" "$(q "SELECT coalesce(token_contract_address,'') FROM tokens WHERE id='$ID_ONE'")"

printf '\n== a success the chain cannot confirm is stored, but unverified ==\n'
R=$(req POST /api/creations "{\"wallet_address\":\"$WALLET\",\"network\":\"Base Sepolia\",\"token_name\":\"E2E Two\",\"token_symbol\":\"E2ETWO\",\"total_supply\":\"2000\",\"decimals\":6,\"status\":\"deploying\"}")
check "second create succeeds" "200" "$(status_of "$R")"
ID_TWO=$(body_of "$R" | jsonfield record.id)
R=$(req PATCH "/api/creations/$ID_TWO" "{\"status\":\"success\",\"token_contract_address\":\"$FAKE_TOKEN\",\"transaction_hash\":\"$UNMINED_TX\"}")
check "unmined transaction is accepted but flagged" "200" "$(status_of "$R")"
check "stored as success" "success" "$(q "SELECT status FROM tokens WHERE id='$ID_TWO'")"
check "but chain_verified is false" "f" "$(q "SELECT chain_verified FROM tokens WHERE id='$ID_TWO'")"
check "with a reason recorded" "t" "$(q "SELECT verification_note IS NOT NULL FROM tokens WHERE id='$ID_TWO'")"

printf '\n== a record cannot be re-pointed at another token ==\n'
R=$(req PATCH "/api/creations/$ID_TWO" "{\"status\":\"success\",\"token_contract_address\":\"$OTHER_TOKEN\",\"transaction_hash\":\"$UNMINED_TX\"}")
check "re-pointing is refused" "409" "$(status_of "$R")"
check "the original address is unchanged" "$FAKE_TOKEN" "$(q "SELECT token_contract_address FROM tokens WHERE id='$ID_TWO'")"

printf '\n== a failure is recorded without inventing anything ==\n'
R=$(req PATCH "/api/creations/$ID_ONE" '{"status":"deployment_cancelled","verification_note":"The user rejected the request in their wallet."}')
check "failure is recorded" "200" "$(status_of "$R")"
check "status is the failure status" "deployment_cancelled" "$(q "SELECT status FROM tokens WHERE id='$ID_ONE'")"
check "no token address was invented" "" "$(q "SELECT coalesce(token_contract_address,'') FROM tokens WHERE id='$ID_ONE'")"
check "no transaction hash was invented" "" "$(q "SELECT coalesce(transaction_hash,'') FROM tokens WHERE id='$ID_ONE'")"
check "never marked verified" "f" "$(q "SELECT chain_verified FROM tokens WHERE id='$ID_ONE'")"

printf '\n== one wallet, many records ==\n'
R=$(req POST /api/creations "{\"wallet_address\":\"$WALLET\",\"network\":\"Base Sepolia\",\"token_name\":\"E2E Three\",\"token_symbol\":\"E2ETHREE\",\"total_supply\":\"3000\",\"decimals\":18,\"status\":\"deploying\"}")
ID_THREE=$(body_of "$R" | jsonfield record.id)
check "third record for the same wallet" "200" "$(status_of "$R")"
check "wallet owns 3 rows" "3" "$(q "SELECT count(*) FROM tokens WHERE lower(wallet_address)=lower('$WALLET') AND token_symbol LIKE 'E2E%'")"

printf '\n== admin search by wallet ==\n'
# -w is needed here too: without it there is no status line to read.
aget() {
  curl -sS --max-time 40 -H "Cookie: tokenbase_admin=$SECRET" \
    -w '\n%{http_code}' "$BASE/api/admin/records$1"
}

R=$(aget "?wallet=$WALLET")
check "admin search returns 200" "200" "$(status_of "$R")"
TOTAL=$(body_of "$R" | jsonfield total)
# At least the three this run created. The count can legitimately be higher:
# this is the operator's real wallet, so genuine creations add to it over time.
[ -n "${TOTAL:-}" ] && [ "$TOTAL" -ge 3 ] 2>/dev/null && pass "search finds every record for the wallet  (total=$TOTAL)" || fail "search found ${TOTAL:-nothing}"
check "search result includes the token address" "true" \
  "$(body_of "$R" | grep -q "$FAKE_TOKEN" && echo true || echo false)"

R=$(aget "?q=E2EONE")
check "searching by symbol finds exactly one" "1" "$(body_of "$R" | jsonfield total)"

R=$(aget "?contract=$FAKE_TOKEN")
check "searching by token contract finds one" "1" "$(body_of "$R" | jsonfield total)"

R=$(aget "?wallet=not-an-address")
check "a malformed wallet filter is explained" "400" "$(status_of "$R")"

R=$(aget "?limit=")
check "an empty limit still returns a full page" "200" "$(status_of "$R")"
check "and it is more than one record" "true" \
  "$([ "$(body_of "$R" | jsonfield total)" -gt 1 ] 2>/dev/null && echo true || echo false)"

printf '\n== one wallet with no records ==\n'
R=$(aget "?wallet=$WALLET_B")
check "an unknown wallet returns zero, not an error" "200" "$(status_of "$R")"
check "with no records" "0" "$(body_of "$R" | jsonfield total)"

printf '\n== cleanup ==\n'
DELETED=$(q "DELETE FROM tokens WHERE token_symbol IN ('E2EONE','E2ETWO','E2ETHREE','PROBE') RETURNING id" | grep -c '[0-9a-f]\{8\}-' || true)
pass "removed $DELETED test rows (including the earlier PROBE row)"
check "no test rows remain" "0" \
  "$(q "SELECT count(*) FROM tokens WHERE token_symbol IN ('E2EONE','E2ETWO','E2ETHREE','PROBE')")"

printf '\n'
if [ "$FAILED" = "1" ]; then
  echo "RESULT: E2E RECORD TEST FAILED"
  exit 1
fi
echo "RESULT: E2E RECORD TEST PASSED"
