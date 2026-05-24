import { actorFromRequest } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

const finalStatuses = new Set(["verified", "rejected"]);

type Actor = ReturnType<typeof actorFromRequest>;

export async function applySlipStatus(input: {
  slipId: string;
  status: string;
  reason?: string | null;
  actor: Actor;
  auditAction?: string;
  source?: string;
}) {
  const supabase = createServiceClient();
  const { data: slip, error } = await supabase
    .from("slip_submissions")
    .select("*")
    .eq("id", input.slipId)
    .single();

  if (error) throw error;

  if (finalStatuses.has(slip.status) && slip.status !== input.status) {
    throw new Error("สลิปนี้ถูกตรวจเรียบร้อยแล้ว กรุณารีเฟรชข้อมูลล่าสุด");
  }

  const now = new Date().toISOString();
  const { data: updatedSlip, error: updateSlipError } = await supabase
    .from("slip_submissions")
    .update({
      status: input.status,
      rejection_reason: input.status === "verified" ? null : input.reason ?? null
    })
    .eq("id", input.slipId)
    .select("*")
    .single();

  if (updateSlipError) throw updateSlipError;

  let target:
    | {
        id: string;
        display_name: string;
        amount_due: number;
        selected_line_user_id: string | null;
        events?: { id: string; name: string } | Array<{ id: string; name: string }> | null;
      }
    | null = null;

  if (slip.payment_target_id) {
    const targetStatus = input.status === "verified" ? "verified" : input.status;
    const { error: updateTargetError } = await supabase
      .from("payment_targets")
      .update({
        status: targetStatus,
        paid_slip_submission_id: input.status === "verified" ? input.slipId : null,
        paid_at: input.status === "verified" ? now : null
      })
      .eq("id", slip.payment_target_id);

    if (updateTargetError) throw updateTargetError;

    const { data: targetData, error: targetError } = await supabase
      .from("payment_targets")
      .select("id,display_name,amount_due,selected_line_user_id,events(id,name)")
      .eq("id", slip.payment_target_id)
      .maybeSingle();

    if (targetError) throw targetError;
    target = targetData as typeof target;
  }

  const audit = await supabase.from("audit_logs").insert({
    ...input.actor,
    action: input.auditAction ?? "update_slip_status",
    entity_type: "slip_submission",
    entity_id: input.slipId,
    event_id: slip.event_id,
    before_data: slip,
    after_data: updatedSlip,
    reason: input.reason ?? null
  });

  if (audit.error) throw audit.error;

  if (input.status === "verified" || input.status === "rejected") {
    await notifyLineUserAfterReview({
      slipId: input.slipId,
      status: input.status,
      slipLineUserId: slip.line_user_id,
      target,
      reason: input.reason
    }).catch(async (notifyError) => {
      await supabase.from("audit_logs").insert({
        ...input.actor,
        action: "line_push_failed",
        entity_type: "slip_submission",
        entity_id: input.slipId,
        event_id: slip.event_id,
        after_data: { error: notifyError instanceof Error ? notifyError.message : String(notifyError) },
        reason: "แจ้งผลผู้ใช้ทาง LINE ไม่สำเร็จ"
      });
    });
  }

  return updatedSlip;
}

async function notifyLineUserAfterReview(input: {
  slipId: string;
  status: string;
  slipLineUserId?: string | null;
  target: {
    display_name: string;
    amount_due: number;
    selected_line_user_id: string | null;
    events?: { name: string } | Array<{ name: string }> | null;
  } | null;
  reason?: string | null;
}) {
  const supabase = createServiceClient();
  await supabase.from("audit_logs").insert({
    actor_email: "system",
    actor_role: "viewer",
    action: "line_push_disabled",
    entity_type: "slip_submission",
    entity_id: input.slipId,
    after_data: {
      status: input.status,
      slip_line_user_id: input.slipLineUserId ?? null,
      target_line_user_id: input.target?.selected_line_user_id ?? null
    },
    reason: "ปิดการแจ้งเตือนผู้ใช้ทาง LINE เพื่อไม่ใช้โควตา Messaging API"
  });
}
