import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, safeEqual } from "../../../../lib/admin-auth";

export const runtime = "nodejs";

function valid(value: string | undefined): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!value || !secret) return false;
  return safeEqual(value, secret);
}

export async function GET(request: NextRequest) {
  return NextResponse.json({ authenticated: valid(request.cookies.get(ADMIN_COOKIE)?.value) });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { secret?: string };

  if (!valid(body.secret)) {
    return NextResponse.json({ error: "Invalid admin credentials." }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(ADMIN_COOKIE, body.secret as string, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
