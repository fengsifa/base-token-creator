/**
 * How a token-creation record gets written.
 *
 * This module exists because of a real bug. The creator used one function for
 * every write, choosing POST or PATCH from a piece of client state:
 *
 *     fetch(recordId ? `/api/creations/${recordId}` : "/api/creations", ...)
 *
 * The payloads that advance a record's status (`{ status: "success",
 * token_contract_address, transaction_hash }`) carry no wallet address, because
 * for a PATCH they do not need one. But when the record had not been created yet
 * — which happens whenever the first write failed, and it failed for everyone
 * while the app could not resolve its database host — those partial payloads took
 * the POST branch, and POST requires a wallet address. The user saw:
 *
 *     wallet_address must be a valid EVM address.
 *
 * Two rules keep that from coming back, and both are enforced here rather than in
 * the component:
 *
 *  1. A POST always carries the complete creation context. A partial payload is
 *     never eligible for POST.
 *  2. A PATCH needs a real record id. Without one there is nothing to patch, so
 *     the write becomes a POST of the full context instead of a partial POST.
 *
 * Keeping the decision in a pure function means it can be tested without a
 * browser, a wallet or a database.
 */

/** The fields every creation record needs, held in one place on the client. */
export type CreationContext = {
  walletAddress: string;
  network: string;
  tokenName: string;
  tokenSymbol: string;
  /** Human-entered supply, e.g. "1000000". */
  totalSupply: string;
  decimals: number;
  logoUrl?: string | null;
  /**
   * Which optional features the token was created with.
   *
   * Part of the creation context rather than a later update because they describe
   * what was bought, not how the attempt went. They are recorded only: the backend
   * can neither enable nor disable a feature — the deployed contract is the sole
   * authority on what a token can do.
   */
  burnable: boolean;
  mintable: boolean;
  pausable: boolean;
};

/** Fields a later write may add or change. */
export type RecordUpdate = Record<string, unknown>;

export type RecordWritePlan = {
  method: "POST" | "PATCH";
  url: string;
  body: Record<string, unknown>;
  /** Short explanation, surfaced in logs and asserted in tests. */
  reason: string;
};

export const CREATIONS_ENDPOINT = "/api/creations";

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * True when a value can be used as a record id.
 *
 * localStorage is user-writable, so a stored id is not trusted; anything that is
 * not a UUID is treated as "no record yet" and the write becomes a create.
 */
export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** True for a well-formed EVM address. */
export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value.trim());
}

/**
 * Check the context a POST would carry.
 *
 * Returns human-readable problems; an empty array means the context is complete
 * enough to create a record. This mirrors the API's own validation, so a client
 * that passes here will not be rejected with a 400.
 */
export function checkCreationContext(context: Partial<CreationContext>): string[] {
  const problems: string[] = [];

  if (!context.walletAddress || !ADDRESS_PATTERN.test(context.walletAddress.trim())) {
    problems.push(
      "The connected wallet address is missing or not a valid EVM address, so no record can be created.",
    );
  }
  if (!context.network || !context.network.trim()) {
    problems.push("The network name is missing.");
  }
  if (!context.tokenName || !context.tokenName.trim()) {
    problems.push("The token name is missing.");
  }
  if (!context.tokenSymbol || !context.tokenSymbol.trim()) {
    problems.push("The token symbol is missing.");
  }
  if (!context.totalSupply || !context.totalSupply.trim()) {
    problems.push("The total supply is missing.");
  }
  if (
    context.decimals === undefined ||
    !Number.isInteger(context.decimals) ||
    context.decimals < 0 ||
    context.decimals > 18
  ) {
    problems.push("Decimals must be a whole number between 0 and 18.");
  }

  // The feature flags are part of the creation context, so a POST must carry
  // them. A record missing them would misdescribe what exists on chain, which is
  // worse than declining to write it.
  for (const key of ["burnable", "mintable", "pausable"] as const) {
    if (typeof context[key] !== "boolean") {
      problems.push(`The feature flag "${key}" is missing from the creation context.`);
    }
  }

  return problems;
}

/** The column names the API expects for a create. */
export function contextToPayload(context: CreationContext): Record<string, unknown> {
  return {
    wallet_address: context.walletAddress.trim(),
    network: context.network.trim(),
    token_name: context.tokenName.trim(),
    token_symbol: context.tokenSymbol.trim(),
    total_supply: context.totalSupply.trim(),
    decimals: context.decimals,
    logo_url: context.logoUrl ?? null,
    burnable: context.burnable,
    mintable: context.mintable,
    pausable: context.pausable,
  };
}

/**
 * Decide the request for one write.
 *
 * `update` carries whatever is new — a status, a contract address, a transaction
 * hash. It is merged into the full context whenever the write has to be a POST,
 * which is what makes the payload complete by construction.
 */
export function planRecordWrite(args: {
  recordId: string;
  context: CreationContext;
  update: RecordUpdate;
}): RecordWritePlan {
  const { recordId, context, update } = args;
  const hasRecord = UUID_PATTERN.test(recordId);

  if (hasRecord && Object.keys(update).length > 0) {
    return {
      method: "PATCH",
      url: `${CREATIONS_ENDPOINT}/${recordId}`,
      body: update,
      reason: "record exists and there is something to update",
    };
  }

  if (hasRecord) {
    return {
      method: "PATCH",
      url: `${CREATIONS_ENDPOINT}/${recordId}`,
      body: {},
      reason: "record exists and there is nothing new to write",
    };
  }

  // No usable record id: the only correct move is to create the record properly.
  // A partial POST here is the bug this module exists to prevent.
  //
  // The context is spread last on purpose. It holds the identity of the creation
  // — who paid for it and what they asked for — and an `update` object must never
  // be able to overwrite that with something else.
  return {
    method: "POST",
    url: CREATIONS_ENDPOINT,
    body: { ...update, ...contextToPayload(context) },
    reason:
      Object.keys(update).length > 0
        ? "no record id yet, so the full context is sent instead of a partial insert"
        : "first write for this attempt",
  };
}

/**
 * A PATCH that 404s means the record is gone (a different browser, a cleared
 * database, an expired attempt). Re-planning without an id turns the retry into a
 * complete create rather than a doomed patch.
 */
export function shouldRecreateAsPost(status: number, method: RecordWritePlan["method"]): boolean {
  return method === "PATCH" && status === 404;
}

// ---------------------------------------------------------------------------
// Status lifecycle
// ---------------------------------------------------------------------------

/** Statuses a record may be moved to from the client, mirroring the API's list. */
export const CLIENT_STATUSES = [
  "pending_payment",
  "payment_confirmed",
  "deploying",
  "success",
  "failed",
  "payment_cancelled",
  "deployment_cancelled",
] as const;

export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * What a record should look like after an on-chain outcome.
 *
 * A creation only becomes `success` once the token address has been read from the
 * TokenCreated event in a mined receipt. Anything else is a failure state, and a
 * failure never carries a token address or a transaction hash of its own — that
 * is how a fake success would get in.
 */
export function successWrite(args: {
  tokenAddress: string;
  transactionHash: string;
}): RecordUpdate {
  return {
    status: "success",
    token_contract_address: args.tokenAddress,
    transaction_hash: args.transactionHash,
  };
}

/**
 * A failed attempt writes its status and the reason, and nothing else.
 *
 * `verification_note` is a real column, so the reason survives for the admin to
 * read. There is deliberately no token address and no transaction hash here: a
 * failed attempt produced no token, and inventing identifiers for it is exactly
 * how a fake success would enter the records.
 */
export function failureWrite(args: {
  status: Extract<ClientStatus, "failed" | "payment_cancelled" | "deployment_cancelled">;
  reason: string;
}): RecordUpdate {
  return {
    status: args.status,
    verification_note: args.reason,
  };
}
