import { actorFromRequest } from "@/lib/auth";
import { getLineMessageQuota, pushLine } from "@/lib/line";
import { getLinePushPolicy, getSettings } from "@/lib/settings";
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
  const settings = await getSettings(["line_push_policy"]);
  if (getLinePushPolicy(settings) === "disabled") return;

  const quota = await getLineMessageQuota();
  const supabase = createServiceClient();
  if (!quota.canPush) {
    await supabase.from("audit_logs").insert({
      actor_email: "system",
      actor_role: "viewer",
      action: "line_push_skipped_quota",
      entity_type: "slip_submission",
      entity_id: input.slipId,
      after_data: quota,
      reason: "LINE quota ไม่พอหรือเช็กได้เป็นโหมดไม่จำกัด/ไม่ทราบค่า"
    });
    return;
  }

  const lineUserUuid = input.slipLineUserId ?? input.target?.selected_line_user_id;
  if (!lineUserUuid) return;

  const { data: lineUser, error } = await supabase
    .from("line_users")
    .select("line_user_id")
    .eq("id", lineUserUuid)
    .maybeSingle();

  if (error) throw error;
  if (!lineUser?.line_user_id) return;

  const eventRow = Array.isArray(input.target?.events)
    ? input.target?.events[0]
    : input.target?.events;
  const eventName = eventRow?.name ?? "งานที่เลือกไว้";
  const amount = Number(input.target?.amount_due ?? 0).toLocaleString("th-TH");
  const displayName = input.target?.display_name ?? "รายชื่อของคุณ";

  const text =
    input.status === "verified"
      ? `✅ จ่ายเรียบร้อย\n${eventName}\n${displayName}\nยอด ${amount} บาท`
      : `❌ สลิปไม่ถูกต้อง\n${eventName}\n${displayName}\n${input.reason ? `เหตุผล: ${input.reason}` : "กรุณาติดต่อผู้ดูแลหรือส่งสลิปใหม่"}`;

  const pushed = await pushLine(lineUser.line_user_id, [{ type: "text", text }]);
  await supabase.from("audit_logs").insert({
    actor_email: "system",
    actor_role: "viewer",
    action: pushed.ok ? "line_push_sent" : "line_push_failed",
    entity_type: "slip_submission",
    entity_id: input.slipId,
    after_data: { quota, push: pushed },
    reason: "แจ้งผลตรวจสลิปให้ผู้ใช้ทาง LINE"
  });
}
