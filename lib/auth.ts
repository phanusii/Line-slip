import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";

type Role = "admin" | "viewer";

export type AdminSession = {
  email: string;
  role: Role;
  exp: number;
};

export const adminSessionCookieName = "line_slip_admin_session";

const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;

function jsonResponse(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret === "change-me") {
    throw jsonResponse("กรุณาตั้งค่า ADMIN_SESSION_SECRET ก่อนใช้งานระบบผู้ดูแล", 500);
  }

  return secret;
}

function adminEmail() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) {
    throw jsonResponse("กรุณาตั้งค่า ADMIN_EMAIL ก่อนใช้งานระบบผู้ดูแล", 500);
  }

  return email;
}

function adminPasswordHash() {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash || !hash.startsWith("scrypt$")) {
    throw jsonResponse("กรุณาตั้งค่า ADMIN_PASSWORD_HASH ก่อนใช้งานระบบผู้ดูแล", 500);
  }

  return hash;
}

function sign(payload: string) {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function hashPassword(password: string, salt = randomBytes(16).toString("base64url")) {
  const derived = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [, salt, expectedKey] = storedHash.split("$");
  if (!salt || !expectedKey) return false;

  const actualKey = scryptSync(password, salt, 64).toString("base64url");
  return safeEqual(actualKey, expectedKey);
}

export function createAdminSession(email: string, role: Role = "admin") {
  const payload = base64UrlEncode(
    JSON.stringify({
      email,
      role,
      exp: Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds
    })
  );

  return `${payload}.${sign(payload)}`;
}

export function verifyAdminSession(token: string | undefined): AdminSession | null {
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;

  try {
    const session = JSON.parse(base64UrlDecode(payload)) as AdminSession;
    if (!session.email || !session.role || !session.exp) return null;
    if (session.exp <= Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export function getAdminSession(request: NextRequest) {
  return verifyAdminSession(request.cookies.get(adminSessionCookieName)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production"
  };
}

export function expiredSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production"
  };
}

export function verifyAdminCredentials(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!safeEqual(normalizedEmail, adminEmail())) return null;
  if (!verifyPassword(password, adminPasswordHash())) return null;

  return {
    email: normalizedEmail,
    role: "admin" as const
  };
}

export function assertAdmin(request: NextRequest, requiredRole: Role = "admin") {
  const session = getAdminSession(request);

  if (!session) {
    throw jsonResponse("กรุณาเข้าสู่ระบบผู้ดูแลก่อนใช้งาน", 401);
  }

  if (requiredRole === "admin" && session.role !== "admin") {
    throw jsonResponse("บัญชีนี้ไม่มีสิทธิ์แก้ไขหรือลบข้อมูล", 403);
  }

  return session;
}

export function actorFromRequest(request: NextRequest) {
  const session = getAdminSession(request);

  return {
    actor_email: session?.email ?? "unknown-admin",
    actor_role: session?.role ?? ("admin" as const)
  };
}
