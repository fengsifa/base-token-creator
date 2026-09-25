import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "../../../../lib/admin-auth";
import { getRecordsByWallet, listWallets, searchTokenRecords } from "../../../../lib/database";
import { parseRecordQuery } from "../../../../lib/record-query";

export const runtime = "nodejs";

/**
 * Search token creation records.
 *
 * Admin only: this endpoint can list every wallet's creations, so it must never
 * be reachable from a normal user's browser session. The guard is the shared
 * admin cookie, the same one /admin uses.
 *
 *   ?wallet=0x...      every token one wallet created
 *   ?contract=0x...    the record for one token contract
 *   ?q=mtk             substring of the token name or symbol
 *   ?status=success    exact status
 *   ?wallets=1         include the wallet list with per-wallet counts
 */
export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = parseRecordQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { wallet, contract, query, status, limit, offset, includeWallets } = parsed.filters;

  try {
    const result = wallet
      ? await getRecordsByWallet(wallet, limit)
      : await searchTokenRecords({ contract, query, status, limit, offset });

    return NextResponse.json({
      ...result,
      filters: { wallet, contract, q: query, status, limit, offset },
      wallets: includeWallets ? await listWallets() : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 503 },
    );
  }
}
