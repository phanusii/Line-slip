import { actorFromRequest } from "@/lib/auth";
import { buildApprovalRejectedFlex, buildApprovalVerifiedFlex, liffUri, pushLine } from "@/lib/line";
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

  // หา line_users DB id: ให้ความสำคัญ selected_line_user_id ก่อน (ผู้เลือก QR)
  // ตามด้วย slipLineUserId (ผู้อัปสลิป) — ปกติจะเป็นคนเดียวกัน
  const lineUserDbId = input.target?.selected_line_user_id ?? input.slipLineUserId ?? null;

  if (!lineUserDbId) {
    console.log(`[slip-status] notifyLineUserAfterReview: ไม่พบ line_user_id — ข้ามการแจ้งเตือน slipId=${input.slipId}`);
    return;
  }

  // แปลง DB uuid → LINE user ID string (Uxxxxxxxx)
  const { data: lineUser } = await supabase
    .from("line_users")
    .select("line_user_id")
    .eq("id", lineUserDbId)
    .maybeSingle();

  if (!lineUser?.line_user_id) {
    console.log(`[slip-status] notifyLineUserAfterReview: ไม่พบ line_user_id ใน DB — ข้ามการแจ้งเตือน slipId=${input.slipId}`);
    return;
  }

  const lineUserId = lineUser.line_user_id;
  const eventRow = Array.isArray(input.target?.events) ? input.target?.events[0] : input.target?.events;
  const eventName = eventRow?.name ?? "ไม่พบชื่องาน";
  const displayName = input.target?.display_name ?? "ไม่พบชื่อ";
  const amountDue = Number(input.target?.amount_due ?? 0);

  let message: unknown;
  if (input.status === "verified") {
    message = buildApprovalVerifiedFlex({
      displayName,
      eventName,
      amountDue,
      paidAt: new Date().toISOString(),
      liffMeUrl: liffUri("me")
    });
  } else {
    message = buildApprovalRejectedFlex({
      displayName,
      eventName,
      amountDue,
      reason: input.reason ?? null,
      liffSlipUrl: liffUri("slip")
    });
  }

  const result = await pushLine(lineUserId, [message]);

  if (!result.ok) {
    throw new Error(`LINE push ไม่สำเร็จ: ${result.error ?? "unknown error"}`);
  }

  console.log(`[slip-status] ส่งแจ้งเตือน LINE push สำเร็จ → ${lineUserId} status=${input.status} slipId=${input.slipId}`);

  await supabase.from("audit_logs").insert({
    actor_email: "system",
    actor_role: "viewer",
    action: "line_push_sent",
    entity_type: "slip_submission",
    entity_id: input.slipId,
    after_data: {
      status: input.status,
      line_user_id: lineUserId,
      event_name: eventName,
      display_name: displayName,
      amount_due: amountDue
    },
    reason: input.status === "verified"
      ? "แจ้งผู้ใช้ทาง LINE ว่าสลิปผ่านการอนุมัติแล้ว"
      : "แจ้งผู้ใช้ทาง LINE ว่าสลิปไม่ผ่านการตรวจ"
  });
}
