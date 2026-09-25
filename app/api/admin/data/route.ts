import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "../../../../lib/admin-auth";
import { getAdminData } from "../../../../lib/database";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await getAdminData());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 503 },
    );
  }
}
