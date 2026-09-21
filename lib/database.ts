import { Pool } from "pg";

type TokenPayload = Record<string, unknown>;

declare global {
  // eslint-disable-next-line no-var
  var tokenCreatorPool: Pool | undefined;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  if (!global.tokenCreatorPool) global.tokenCreatorPool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  return global.tokenCreatorPool;
}

const columns = ["wallet_address", "network", "token_name", "token_symbol", "total_supply", "decimals", "logo_url", "contract_address", "deployment_tx_hash", "payment_tx_hash", "status"];

export async function createTokenRecord(payload: TokenPayload) {
  const values = columns.map(column => payload[column] ?? null);
  const placeholders = values.map((_, index) => "$" + (index + 1)).join(", ");
  const result = await getPool().query(`INSERT INTO tokens (${columns.join(", ")}) VALUES (${placeholders}) RETURNING *`, values);
  return result.rows[0];
}

export async function updateTokenRecord(id: string, payload: TokenPayload) {
  const entries = Object.entries(payload).filter(([key]) => [...columns, "updated_at"].includes(key));
  if (!entries.length) return getPool().query("SELECT * FROM tokens WHERE id = $1", [id]).then(result => result.rows[0]);
  const values = entries.map(([, value]) => value);
  const assignments = entries.map(([key], index) => `${key} = $${index + 1}`).join(", ");
  values.push(id);
  const result = await getPool().query(`UPDATE tokens SET ${assignments}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
  return result.rows[0];
}

export async function getAdminData() {
  const result = await getPool().query("SELECT * FROM tokens ORDER BY created_at DESC");
  const rows = result.rows as Array<Record<string, unknown>>;
  const successful = rows.filter(row => row.status === "success");
  const pending = rows.filter(row => ["pending_payment", "payment_confirmed", "deploying"].includes(String(row.status)));
  const failed = rows.filter(row => ["failed", "payment_cancelled", "deployment_cancelled"].includes(String(row.status)));
  const transactions = rows.flatMap(row => [
    { hash: row.payment_tx_hash, type: "payment", wallet: row.wallet_address, network: row.network, status: row.status, created_at: row.created_at },
    { hash: row.deployment_tx_hash, type: "deployment", wallet: row.wallet_address, network: row.network, status: row.status, created_at: row.created_at },
  ]).filter(row => row.hash);
  return { tokens: rows, transactions, metrics: { totalTokens: rows.length, successfulTokens: successful.length, pendingTokens: pending.length, failedTokens: failed.length, successfulPayments: rows.filter(row => row.payment_tx_hash && ["payment_confirmed", "deploying", "success"].includes(String(row.status))).length } };
}

