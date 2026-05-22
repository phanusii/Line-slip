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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");

    // Try database-stored admins first (supports multiple admin/viewer accounts)
    const supabase = createServiceClient();
    let admin = await verifyAdminCredentialsFromDb(supabase, email, password);

    // Fallback to env-var single-admin for backwards compatibility
    if (!admin) {
      admin = verifyAdminCredentials(email, password);
    }

    if (!admin) {
      return NextResponse.json(
        { error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" },
        { status: 401 }
      );
    }

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
