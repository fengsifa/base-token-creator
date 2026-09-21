import { NextRequest, NextResponse } from "next/server";
const cookieName = "tokenbase_admin";
const valid = (value: string | undefined) => Boolean(value && process.env.ADMIN_SECRET && value === process.env.ADMIN_SECRET);
export async function GET(request: NextRequest) { return NextResponse.json({ authenticated: valid(request.cookies.get(cookieName)?.value) }); }
export async function POST(request: NextRequest) { const body = await request.json().catch(() => ({})); if (!valid(body.secret)) return NextResponse.json({ error: "Invalid admin credentials." }, { status: 401 }); const response = NextResponse.json({ authenticated: true }); response.cookies.set(cookieName, body.secret, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 8 }); return response; }
export async function DELETE() { const response = NextResponse.json({ authenticated: false }); response.cookies.set(cookieName, "", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 }); return response; }
