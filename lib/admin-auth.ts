/**
 * Admin session checks, in one place.
 *
 * The admin surface is the only place that can read other people's creation
 * records, so the check lives here rather than being re-written per route — a
 * copy that drifts is how an endpoint ends up accidentally public.
 *
 * The session is the existing one: a cookie holding the shared `ADMIN_SECRET`,
 * set by POST /api/admin/session. This module does not introduce a second scheme.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const ADMIN_COOKIE = "tokenbase_admin";

/** Constant-time comparison, so the secret cannot be probed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, and the length itself is not a
  // secret worth leaking beyond this.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * True when the request carries a valid admin session.
 *
 * Returns false when ADMIN_SECRET is unset, so a deployment that forgot to
 * configure it exposes nothing rather than everything.
 */
export function isAdminRequest(request: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const cookie = request.cookies.get(ADMIN_COOKIE)?.value;
  if (!cookie) return false;
  return safeEqual(cookie, secret);
}
