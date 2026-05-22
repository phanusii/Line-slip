import { NextResponse } from "next/server";
import { adminSessionCookieName, expiredSessionCookieOptions } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(adminSessionCookieName, "", expiredSessionCookieOptions());
  return response;
}
