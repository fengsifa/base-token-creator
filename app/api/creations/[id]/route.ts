import { NextRequest, NextResponse } from "next/server";
import { updateTokenRecord } from "../../../../lib/database";
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

/**
 * Advance a creation record through its lifecycle.
 *
 * `updateTokenRecord` only ever writes an allow-listed column set, so arbitrary
 * keys from the request body cannot reach SQL. Everything else is validated
 * here before it gets that far.
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

  if (body.contract_address !== undefined) {
    const contractAddress = text(body.contract_address);
    if (contractAddress && !ADDRESS_PATTERN.test(contractAddress)) {
      return NextResponse.json({ error: "contract_address must be a valid EVM address." }, { status: 400 });
    }
    payload.contract_address = contractAddress || null;
  }

  for (const key of ["payment_tx_hash", "deployment_tx_hash"] as const) {
    if (body[key] === undefined) continue;
    const value = text(body[key]);
    if (value && !TX_HASH_PATTERN.test(value)) {
      return NextResponse.json({ error: `${key} must be a valid transaction hash.` }, { status: 400 });
    }
    payload[key] = value || null;
  }

  if (body.wallet_address !== undefined) {
    const walletAddress = text(body.wallet_address);
    if (!ADDRESS_PATTERN.test(walletAddress)) {
      return NextResponse.json({ error: "wallet_address must be a valid EVM address." }, { status: 400 });
    }
    payload.wallet_address = walletAddress;
  }

  if (body.logo_url !== undefined) {
    payload.logo_url = text(body.logo_url) || null;
  }

  // Token parameters are immutable once a record exists, but if a client sends
  // them we still refuse silently-invalid values.
  if (body.token_name !== undefined || body.token_symbol !== undefined || body.total_supply !== undefined || body.decimals !== undefined) {
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
