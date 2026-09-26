import { Pool } from "pg";

type TokenPayload = Record<string, unknown>;

declare global {
  // eslint-disable-next-line no-var
  var tokenCreatorPool: Pool | undefined;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  if (!global.tokenCreatorPool) {
    global.tokenCreatorPool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      // Without this, a container that loses the database mid-flight waits
      // forever instead of surfacing an error the route can report.
      connectionTimeoutMillis: 10_000,
    });
  }
  return global.tokenCreatorPool;
}

/**
 * Columns a client is allowed to influence through POST /api/creations.
 *
 * `payment_tx_hash` is the optional service-fee transaction and is deliberately
 * separate from `transaction_hash`, which is the token creation transaction. The
 * current flow charges the fee inside the creation transaction, so
 * `payment_tx_hash` stays null for new records; it is kept because historical rows
 * have it and dropping a column to tidy up would lose that.
 *
 * `burnable`, `mintable` and `pausable` record which features the token was
 * created with. They are written once, on create — see UPDATABLE_COLUMNS.
 */
const INSERT_COLUMNS = [
  "wallet_address",
  "network",
  "token_name",
  "token_symbol",
  "total_supply",
  "decimals",
  "logo_url",
  "token_contract_address",
  "transaction_hash",
  "payment_tx_hash",
  "status",
  "burnable",
  "mintable",
  "pausable",
] as const;

/**
 * Columns the server may set later.
 *
 * Note what is deliberately absent: `burnable`, `mintable` and `pausable` are
 * accepted on create but never on update. They record what was bought, which is
 * settled the moment the token is deployed; letting a later PATCH rewrite them
 * would let this table drift away from the chain, and the chain is the authority.
 *
 * `chain_verified` and `verified_at` are only ever written by the API after it has
 * consulted the chain itself; they are never taken from a request body.
 * `verification_note` explains why a record is not a verified success, so it
 * carries either the server's verification verdict or the client's failure
 * reason, and the server always overwrites it when a record becomes successful.
 */
const UPDATABLE_COLUMNS = [
  "wallet_address",
  "network",
  "token_name",
  "token_symbol",
  "total_supply",
  "decimals",
  "logo_url",
  "token_contract_address",
  "transaction_hash",
  "payment_tx_hash",
  "status",
  "chain_verified",
  "verified_at",
  "verification_note",
] as const;

/** One token creation record, as stored. Timestamps arrive as Date from pg. */
export type TokenRecord = {
  id: string;
  wallet_address: string;
  network: string;
  token_name: string;
  token_symbol: string;
  total_supply: string;
  decimals: number;
  logo_url: string | null;
  token_contract_address: string | null;
  transaction_hash: string | null;
  payment_tx_hash: string | null;
  status: string;
  /**
   * The optional features the token was deployed with.
   *
   * Recorded for display only. Nothing in this application can mint, burn, pause
   * or unpause a token: those powers belong to the creator's wallet and are
   * enforced by the deployed contract.
   */
  burnable: boolean;
  mintable: boolean;
  pausable: boolean;
  chain_verified: boolean;
  verified_at: Date | null;
  verification_note: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function createTokenRecord(payload: TokenPayload): Promise<TokenRecord> {
  const values = INSERT_COLUMNS.map(column => payload[column] ?? null);
  const placeholders = values.map((_, index) => "$" + (index + 1)).join(", ");
  const result = await getPool().query(
    `INSERT INTO tokens (${INSERT_COLUMNS.join(", ")}) VALUES (${placeholders}) RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function updateTokenRecord(id: string, payload: TokenPayload): Promise<TokenRecord> {
  const entries = Object.entries(payload).filter(([key]) =>
    (UPDATABLE_COLUMNS as readonly string[]).includes(key),
  );

  if (!entries.length) {
    const result = await getPool().query("SELECT * FROM tokens WHERE id = $1", [id]);
    return result.rows[0];
  }

  const values = entries.map(([, value]) => value);
  const assignments = entries.map(([key], index) => `${key} = $${index + 1}`).join(", ");
  values.push(id);

  const result = await getPool().query(
    `UPDATE tokens SET ${assignments}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function getTokenRecord(id: string): Promise<TokenRecord | undefined> {
  const result = await getPool().query("SELECT * FROM tokens WHERE id = $1", [id]);
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Admin queries
// ---------------------------------------------------------------------------

export type RecordSearchFilters = {
  /** Exact match, case-insensitive. */
  wallet?: string;
  /** Exact match, case-insensitive. */
  contract?: string;
  /** Substring match against the token name or symbol. */
  query?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

const MAX_LIMIT = 500;

/**
 * Filters are always bound as parameters. Nothing from a request is interpolated
 * into SQL text, so a crafted wallet "address" cannot reach the query planner.
 */
function buildWhere(filters: RecordSearchFilters): { whereSql: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.wallet) {
    conditions.push(`lower(wallet_address) = lower(${bind(filters.wallet)})`);
  }
  if (filters.contract) {
    conditions.push(`lower(token_contract_address) = lower(${bind(filters.contract)})`);
  }
  if (filters.query) {
    // One placeholder reused for both columns keeps the value bound once.
    const pattern = bind(`%${filters.query}%`);
    conditions.push(`(token_name ILIKE ${pattern} OR token_symbol ILIKE ${pattern})`);
  }
  if (filters.status) {
    conditions.push(`status = ${bind(filters.status)}`);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

export async function searchTokenRecords(
  filters: RecordSearchFilters = {},
): Promise<{ records: TokenRecord[]; total: number }> {
  const { whereSql, values } = buildWhere(filters);

  const limit = Math.min(Math.max(1, filters.limit ?? 100), MAX_LIMIT);
  const offset = Math.max(0, filters.offset ?? 0);

  const page = await getPool().query(
    `SELECT * FROM tokens ${whereSql} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const count = await getPool().query(
    `SELECT count(*)::int AS total FROM tokens ${whereSql}`,
    values,
  );

  return { records: page.rows, total: count.rows[0].total as number };
}

/**
 * Every token one wallet has created, newest first, plus the total.
 *
 * One wallet owning many tokens is the designed relationship, so this returns a
 * list without any notion of "the" token for a wallet.
 */
export async function getRecordsByWallet(
  wallet: string,
  limit = MAX_LIMIT,
): Promise<{ wallet: string; records: TokenRecord[]; total: number }> {
  const { records, total } = await searchTokenRecords({
    wallet,
    limit: Math.min(Math.max(1, limit), MAX_LIMIT),
  });
  return { wallet, records, total };
}

/**
 * Wallets that have created tokens, with their counts, so the admin can see the
 * shape of the data before searching for a specific address.
 */
export async function listWallets(
  limit = 200,
): Promise<Array<{ wallet_address: string; token_count: number; last_created_at: Date }>> {
  const result = await getPool().query(
    `SELECT wallet_address,
            count(*)::int AS token_count,
            max(created_at) AS last_created_at
       FROM tokens
      GROUP BY wallet_address
      ORDER BY max(created_at) DESC
      LIMIT $1`,
    [Math.min(Math.max(1, limit), MAX_LIMIT)],
  );
  return result.rows;
}

/**
 * Aggregates for the dashboard. Kept separate from getAdminData so the records
 * page can ask for its own shape without pulling the whole table.
 */
export async function getAdminData() {
  const result = await getPool().query("SELECT * FROM tokens ORDER BY created_at DESC");
  const rows = result.rows as Array<Record<string, unknown>>;

  const successful = rows.filter(row => row.status === "success");
  const pending = rows.filter(row =>
    ["pending_payment", "payment_confirmed", "deploying"].includes(String(row.status)),
  );
  const failed = rows.filter(row =>
    ["failed", "payment_cancelled", "deployment_cancelled"].includes(String(row.status)),
  );

  // Only the deployment transaction is a token creation transaction; the payment
  // leg is listed separately so the two are never conflated.
  const transactions = rows
    .flatMap(row => [
      {
        hash: row.payment_tx_hash,
        type: "payment",
        wallet: row.wallet_address,
        network: row.network,
        status: row.status,
        created_at: row.created_at,
      },
      {
        hash: row.transaction_hash,
        type: "token creation",
        wallet: row.wallet_address,
        network: row.network,
        status: row.status,
        created_at: row.created_at,
        contract: row.token_contract_address,
      },
    ])
    .filter(row => row.hash);

  return {
    tokens: rows,
    transactions,
    metrics: {
      totalTokens: rows.length,
      successfulTokens: successful.length,
      pendingTokens: pending.length,
      failedTokens: failed.length,
      chainVerified: rows.filter(row => row.chain_verified === true).length,
      wallets: new Set(rows.map(row => String(row.wallet_address).toLowerCase())).size,
      successfulPayments: rows.filter(
        row =>
          row.payment_tx_hash &&
          ["payment_confirmed", "deploying", "success"].includes(String(row.status)),
      ).length,
    },
  };
}
