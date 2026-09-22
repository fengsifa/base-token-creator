import { NextRequest, NextResponse } from "next/server";
import { createTokenRecord } from "../../../lib/database";
import { validateTokenInput } from "../../../lib/validation";

export const runtime = "nodejs";

// Next.js only allows specific exports from a route file, so this stays private.
const CREATION_STATUSES = [
  "pending_payment",
  "payment_confirmed",
  "deploying",
  "success",
  "failed",
  "payment_cancelled",
  "deployment_cancelled",
] as const;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Create a token-creation record.
 *
 * The chain is the source of truth; this row is a mirror for the admin view.
 * The same parameter validation the browser runs is re-applied here, so a
 * hand-crafted request cannot insert a record the UI would never produce.
 *
 * Note: `decimals` is validated by value, never by truthiness — 0 is a legal
 * number of decimals and used to be rejected as "missing".
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const walletAddress = text(body.wallet_address);
  if (!ADDRESS_PATTERN.test(walletAddress)) {
    return NextResponse.json(
      { error: "wallet_address must be a valid EVM address." },
      { status: 400 },
    );
  }

  const network = text(body.network);
  if (!network) {
    return NextResponse.json({ error: "network is required." }, { status: 400 });
  }

  const tokenName = text(body.token_name);
  const tokenSymbol = text(body.token_symbol);
  const totalSupply = text(body.total_supply);
  const decimals = body.decimals;

  const validation = validateTokenInput({
    name: tokenName,
    symbol: tokenSymbol,
    supply: totalSupply,
    decimals: typeof decimals === "number" ? decimals : text(decimals),
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.message, errors: validation.errors }, { status: 400 });
  }

  const status = text(body.status) || "pending_payment";
  if (!(CREATION_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `Unknown status "${status}".` }, { status: 400 });
  }

  const contractAddress = text(body.contract_address);
  if (contractAddress && !ADDRESS_PATTERN.test(contractAddress)) {
    return NextResponse.json({ error: "contract_address must be a valid EVM address." }, { status: 400 });
  }

  for (const key of ["payment_tx_hash", "deployment_tx_hash"] as const) {
    const value = text(body[key]);
    if (value && !TX_HASH_PATTERN.test(value)) {
      return NextResponse.json({ error: `${key} must be a valid transaction hash.` }, { status: 400 });
    }
  }

  try {
    const data = await createTokenRecord({
      wallet_address: walletAddress,
      network,
      token_name: validation.value.name,
      token_symbol: validation.value.symbol,
      total_supply: validation.value.supply,
      decimals: validation.value.decimals,
      logo_url: text(body.logo_url) || null,
      contract_address: contractAddress || null,
      deployment_tx_hash: text(body.deployment_tx_hash) || null,
      payment_tx_hash: text(body.payment_tx_hash) || null,
      status,
    });
    return NextResponse.json({ record: Array.isArray(data) ? data[0] : data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 503 },
    );
  }
}
