import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { verifyExternalReviewToken } from "@/lib/admin-review";
import { applySlipStatus } from "@/lib/slip-status";

const allowedActions = new Set(["verified", "rejected"]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slipId: string }> }
) {
  const { slipId } = await context.params;
  const action = request.nextUrl.searchParams.get("action") ?? "";
  const token = request.nextUrl.searchParams.get("token") ?? "";

  try {
    if (!allowedActions.has(action)) {
      return html("ลิงก์ไม่ถูกต้อง", "สถานะที่ส่งมาไม่ถูกต้อง", 400);
    }

    await verifyExternalReviewToken({
      token,
      slipId,
      action: action as "verified" | "rejected"
    });

    await applySlipStatus({
      slipId,
      status: action,
      reason: action === "verified" ? "อนุมัติจาก Telegram/Discord" : "ปฏิเสธจาก Telegram/Discord",
      actor: {
        actor_email: "external-admin-review",
        actor_role: "admin"
      },
      auditAction: action === "verified" ? "external_review_approved" : "external_review_rejected",
      source: "external_review"
    });

    return html(
      action === "verified" ? "อนุมัติสลิปแล้ว" : "ปฏิเสธสลิปแล้ว",
      "ระบบบันทึกผลตรวจเรียบร้อยแล้ว สามารถกลับไปที่ Telegram/Discord หรือ dashboard ได้"
    );
  } catch (error) {
    return html("ตรวจสลิปไม่สำเร็จ", formatApiError(error), 400);
  }
}

function html(title: string, message: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="th"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial,sans-serif;margin:0;background:#f7f9ff;color:#202840"><main style="max-width:520px;margin:12vh auto;padding:24px"><section style="background:#fff;border:1px solid #dfe5f2;border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(32,40,64,.12)"><h1 style="font-size:26px;margin:0 0 10px">${escapeHtml(title)}</h1><p style="line-height:1.6;margin:0;color:#6f7892">${escapeHtml(message)}</p></section></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
