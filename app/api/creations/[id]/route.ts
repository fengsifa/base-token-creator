import { NextRequest, NextResponse } from "next/server";
import { getTokenRecord, updateTokenRecord } from "../../../../lib/database";
import { blocksSuccess, describeOutcome, verifyTokenCreation } from "../../../../lib/chain-verify";
import { validateTokenInput } from "../../../../lib/validation";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const STATUSES = [
  "pending_payment",
  "payment_confirmed",
  "deploying",
  "success",
  "failed",
  "payment_cancelled",
  "deployment_cancelled",
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function field(body: Record<string, unknown>, preferred: string, legacy: string): string {
  return text(body[preferred]) || text(body[legacy]);
}

/**
 * Advance a creation record through its lifecycle.
 *
 * `updateTokenRecord` only ever writes an allow-listed column set, so arbitrary
 * keys from the request body cannot reach SQL.
 *
 * Three integrity rules hold here:
 *
 *  1. `success` requires both a token address and a transaction hash, and the
 *     server confirms them against the chain before storing them. A receipt that
 *     reverted, or that produced a different token, is refused outright.
 *  2. The token address and transaction hash are write-once. A record that
 *     already names its token cannot be quietly re-pointed at another one.
 *  3. `chain_verified` and `verified_at` are never taken from the request. Only
 *     the verification step above can set them.
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_PATTERN.test(params.id)) {
    return NextResponse.json({ error: "Record id must be a UUID." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const payload: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const status = text(body.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: `Unknown status "${status}".` }, { status: 400 });
    }
    payload.status = status;
  }

  const contractAddress = field(body, "token_contract_address", "contract_address");
  if (contractAddress && !ADDRESS_PATTERN.test(contractAddress)) {
    return NextResponse.json(
      { error: "token_contract_address must be a valid EVM address." },
      { status: 400 },
    );
  }

  const transactionHash = field(body, "transaction_hash", "deployment_tx_hash");
  const paymentHash = body.payment_tx_hash === undefined ? undefined : text(body.payment_tx_hash);
  for (const [key, value] of [
    ["transaction_hash", transactionHash],
    ["payment_tx_hash", paymentHash ?? ""],
  ] as const) {
    if (value && !TX_HASH_PATTERN.test(value)) {
      return NextResponse.json({ error: `${key} must be a valid transaction hash.` }, { status: 400 });
    }
  }

  if (body.wallet_address !== undefined) {
    const walletAddress = text(body.wallet_address);
    if (!ADDRESS_PATTERN.test(walletAddress)) {
      return NextResponse.json({ error: "wallet_address must be a valid EVM address." }, { status: 400 });
    }
    payload.wallet_address = walletAddress;
  }

  // The identifiers have to reach the UPDATE, not just the validation above.
  // Omitting them here meant a success record was stored with no token address
  // and no transaction hash — the two fields the whole feature exists to record —
  // and the write-once guard below never fired because the stored value was
  // always null.
  if (contractAddress) payload.token_contract_address = contractAddress;
  if (transactionHash) payload.transaction_hash = transactionHash;
  if (paymentHash !== undefined) payload.payment_tx_hash = paymentHash || null;

  if (body.logo_url !== undefined) {
    payload.logo_url = text(body.logo_url) || null;
  }

  // Token parameters are immutable once a record exists, but if a client sends
  // them we still refuse silently-invalid values.
  if (
    body.token_name !== undefined ||
    body.token_symbol !== undefined ||
    body.total_supply !== undefined ||
    body.decimals !== undefined
  ) {
    const validation = validateTokenInput({
      name: text(body.token_name),
      symbol: text(body.token_symbol),
      supply: text(body.total_supply),
      decimals: typeof body.decimals === "number" ? body.decimals : text(body.decimals),
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.message, errors: validation.errors }, { status: 400 });
    }
    payload.token_name = validation.value.name;
    payload.token_symbol = validation.value.symbol;
    payload.total_supply = validation.value.supply;
    payload.decimals = validation.value.decimals;
  }

  if (Object.keys(payload).length === 0) {
    return NextResponse.json({ error: "No updatable fields were provided." }, { status: 400 });
  }

  let existing;
  try {
    existing = await getTokenRecord(params.id);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 503 },
    );
  }
  if (!existing) return NextResponse.json({ error: "Record not found." }, { status: 404 });

  // Rule 2: the identifiers are write-once.
  if (
    contractAddress &&
    existing.token_contract_address &&
    contractAddress.toLowerCase() !== existing.token_contract_address.toLowerCase()
  ) {
    return NextResponse.json(
      {
        error: `This record already names token ${existing.token_contract_address}. A creation record cannot be re-pointed at a different token.`,
      },
      { status: 409 },
    );
  }
  if (
    transactionHash &&
    existing.transaction_hash &&
    transactionHash.toLowerCase() !== existing.transaction_hash.toLowerCase()
  ) {
    return NextResponse.json(
      {
        error: `This record already names transaction ${existing.transaction_hash}. A creation record cannot be re-pointed at a different transaction.`,
      },
      { status: 409 },
    );
  }

  const finalStatus = typeof payload.status === "string" ? payload.status : existing.status;
  const finalContract = contractAddress || existing.token_contract_address || "";
  const finalHash = transactionHash || existing.transaction_hash || "";

  if (finalStatus === "success") {
    if (!finalContract || !finalHash) {
      return NextResponse.json(
        {
          error:
            "A record cannot become success without both token_contract_address and transaction_hash.",
        },
        { status: 400 },
      );
    }

    // Rule 1: the chain decides, not the caller.
    const verification = await verifyTokenCreation({
      transactionHash: finalHash,
      claimedTokenAddress: finalContract,
    });

    if (blocksSuccess(verification)) {
      return NextResponse.json(
        { error: describeOutcome(verification), outcome: verification.outcome },
        { status: 409 },
      );
    }

    payload.chain_verified = verification.outcome === "verified";
    payload.verified_at = verification.outcome === "verified" ? new Date() : null;
    payload.verification_note = describeOutcome(verification);
  } else if (finalStatus === "failed" || finalStatus === "payment_cancelled" || finalStatus === "deployment_cancelled") {
    // A failure keeps whatever reason the client reported; it never claims to be
    // verified, and it never gains a token address or a transaction hash.
    const reason = text(body.verification_note) || text(body.reason);
    payload.chain_verified = false;
    payload.verified_at = null;
    payload.verification_note = reason || "The attempt did not complete on chain.";
  } else if (body.verification_note !== undefined) {
    payload.verification_note = text(body.verification_note);
  }

  try {
    const data = await updateTokenRecord(params.id, payload);
    if (!data) return NextResponse.json({ error: "Record not found." }, { status: 404 });
    return NextResponse.json({ record: Array.isArray(data) ? data[0] : data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 503 },
    );
  }
}
