import { NextRequest, NextResponse } from "next/server";
import {
  adminSessionCookieName,
  createAdminSession,
  sessionCookieOptions,
  verifyAdminCredentials,
  verifyAdminCredentialsFromDb
} from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

const loginWindowMs = 15 * 60 * 1000;
const loginMaxFailures = 5;
const loginAttempts = new Map<string, { count: number; firstAt: number; lockedUntil?: number }>();

function requestIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown-ip"
  );
}

function rateLimitKey(request: NextRequest, email: string) {
  return `${requestIp(request)}:${email.trim().toLowerCase()}`;
}

function isLoginLimited(key: string) {
  const now = Date.now();
  const attempt = loginAttempts.get(key);

  if (!attempt) return false;
  if (attempt.lockedUntil && attempt.lockedUntil > now) return true;
  if (now - attempt.firstAt > loginWindowMs) {
    loginAttempts.delete(key);
    return false;
  }

  return false;
}

function recordLoginFailure(key: string) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  const attempt =
    current && now - current.firstAt <= loginWindowMs
      ? { ...current, count: current.count + 1 }
      : { count: 1, firstAt: now };

  if (attempt.count >= loginMaxFailures) {
    attempt.lockedUntil = now + loginWindowMs;
  }

  loginAttempts.set(key, attempt);
}

async function auditLogin(
  supabase: ReturnType<typeof createServiceClient>,
  opts: { email: string; role?: "admin" | "viewer" | null; success: boolean; reason: string }
) {
  await supabase.from("audit_logs").insert({
    actor_email: opts.email || "unknown",
    actor_role: opts.role ?? null,
    action: opts.success ? "admin_login_success" : "admin_login_failed",
    entity_type: "admin_session",
    reason: opts.reason
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    const normalizedEmail = email.trim().toLowerCase();
    const key = rateLimitKey(request, normalizedEmail);

    if (isLoginLimited(key)) {
      return NextResponse.json(
        { error: "เข้าสู่ระบบผิดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่" },
        { status: 429 }
      );
    }

    // Try database-stored admins first (supports multiple admin/viewer accounts)
    const supabase = createServiceClient();
    let admin = await verifyAdminCredentialsFromDb(supabase, email, password);

    // Fallback to env-var single-admin for backwards compatibility
    if (!admin) {
      admin = verifyAdminCredentials(email, password);
    }

    if (!admin) {
      recordLoginFailure(key);
      await auditLogin(supabase, {
        email: normalizedEmail,
        role: null,
        success: false,
        reason: "invalid_credentials"
      });
      return NextResponse.json(
        { error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" },
        { status: 401 }
      );
    }

    loginAttempts.delete(key);
    await auditLogin(supabase, {
      email: admin.email,
      role: admin.role,
      success: true,
      reason: "password_login"
    });

    const response = NextResponse.json({
      user: {
        email: admin.email,
        role: admin.role
      }
    });

    response.cookies.set(
      adminSessionCookieName,
      createAdminSession(admin.email, admin.role),
      sessionCookieOptions()
    );

    return response;
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
