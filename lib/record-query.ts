/**
 * Parsing and validation for the admin record queries.
 *
 * This lives outside the route so it can be unit tested. The bug that prompted
 * it: `Number(null)` is `0`, not `NaN`, so a missing `?limit=` was clamped up
 * from 0 to the minimum of 1 and every search silently returned a single row.
 * Turning an absent value into a present-but-wrong one is exactly the kind of
 * mistake a test on the parser catches and a route test does not.
 */

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export const RECORD_LIMIT_DEFAULT = 100;
export const RECORD_LIMIT_MAX = 500;

/**
 * Read a bounded integer from a query string.
 *
 * Absent means "use the default", and the default is a real default rather than
 * the minimum. Values that are present but unusable also fall back rather than
 * erroring: a mistyped `limit` should not break a search.
 */
export function clampInt(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null || value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export type RecordQuery = {
  wallet: string;
  contract: string;
  query: string;
  status: string;
  limit: number;
  offset: number;
  includeWallets: boolean;
};

export type RecordQueryResult =
  | { ok: true; filters: RecordQuery }
  | { ok: false; error: string };

/**
 * Build the filters for `GET /api/admin/records`.
 *
 * A malformed address is an error rather than an empty result, because "no such
 * wallet" and "that is not an address" mean very different things to an operator.
 */
export function parseRecordQuery(params: URLSearchParams): RecordQueryResult {
  const wallet = (params.get("wallet") ?? "").trim();
  const contract = (params.get("contract") ?? "").trim();

  for (const [label, value] of [
    ["wallet", wallet],
    ["contract", contract],
  ] as const) {
    if (value && !ADDRESS_PATTERN.test(value)) {
      return {
        ok: false,
        error: `${label} must be a valid EVM address (0x followed by 40 hex characters).`,
      };
    }
  }

  return {
    ok: true,
    filters: {
      wallet,
      contract,
      query: (params.get("q") ?? "").trim(),
      status: (params.get("status") ?? "").trim(),
      limit: clampInt(params.get("limit"), RECORD_LIMIT_DEFAULT, 1, RECORD_LIMIT_MAX),
      offset: clampInt(params.get("offset"), 0, 0, 1_000_000),
      includeWallets: params.get("wallets") === "1",
    },
  };
}
