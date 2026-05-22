import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { applySlipStatus } from "@/lib/slip-status";

const allowedStatuses = new Set([
  "verified",
  "manual_review",
  "amount_mismatch",
  "duplicate_slip",
  "rejected"
]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slipId: string }> }
) {
  try {
    assertAdmin(request);
    const { slipId } = await context.params;
    const body = (await request.json()) as { status?: string; reason?: string };

    if (!body.status || !allowedStatuses.has(body.status)) {
      return NextResponse.json({ error: "สถานะสลิปไม่ถูกต้อง" }, { status: 400 });
    }

    const slip = await applySlipStatus({
      slipId,
      status: body.status,
      reason: body.reason ?? null,
      actor: actorFromRequest(request),
      auditAction: "update_slip_status",
      source: "dashboard"
    });

    return NextResponse.json({ ok: true, slip });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
