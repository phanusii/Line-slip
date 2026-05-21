import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

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

    const supabase = createServiceClient();
    const { data: slip, error } = await supabase
      .from("slip_submissions")
      .select("*")
      .eq("id", slipId)
      .single();

    if (error) throw error;

    const now = new Date().toISOString();
    const updateSlip = await supabase
      .from("slip_submissions")
      .update({
        status: body.status,
        rejection_reason: body.reason ?? null
      })
      .eq("id", slipId)
      .select("*")
      .single();

    if (updateSlip.error) throw updateSlip.error;

    if (slip.payment_target_id) {
      const targetStatus = body.status === "verified" ? "verified" : body.status;
      const updateTarget = await supabase
        .from("payment_targets")
        .update({
          status: targetStatus,
          paid_slip_submission_id: body.status === "verified" ? slipId : null,
          paid_at: body.status === "verified" ? now : null
        })
        .eq("id", slip.payment_target_id);

      if (updateTarget.error) throw updateTarget.error;
    }

    const audit = await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "update_slip_status",
      entity_type: "slip_submission",
      entity_id: slipId,
      event_id: slip.event_id,
      before_data: slip,
      after_data: updateSlip.data,
      reason: body.reason ?? null
    });

    if (audit.error) throw audit.error;

    return NextResponse.json({ ok: true, slip: updateSlip.data });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
