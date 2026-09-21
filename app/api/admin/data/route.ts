import { NextRequest, NextResponse } from "next/server";
import { getAdminData } from "../../../../lib/database";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!process.env.ADMIN_SECRET || request.cookies.get("tokenbase_admin")?.value !== process.env.ADMIN_SECRET) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await getAdminData()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Database error" }, { status: 503 }); }
}

