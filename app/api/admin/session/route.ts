import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const cookieName = "tokenbase_admin";

/** Constant-time comparison so the admin secret cannot be probed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function valid(value: string | undefined): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!value || !secret) return false;
  return safeEqual(value, secret);
}

export async function GET(request: NextRequest) {
  return NextResponse.json({ authenticated: valid(request.cookies.get(cookieName)?.value) });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { secret?: string };

  if (!valid(body.secret)) {
    return NextResponse.json({ error: "Invalid admin credentials." }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(cookieName, body.secret as string, {
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
  response.cookies.set(cookieName, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
