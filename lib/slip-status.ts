import { actorFromRequest } from "@/lib/auth";
import { buildApprovalVerifiedFlex, liffUri, pushLineQuotaAware, type LineQuotaAwarePushResult } from "@/lib/line";
import { getLinePushPolicy, getSettings } from "@/lib/settings";
import { createServiceClient } from "@/lib/supabase/server";
import { sendTelegramLineQuotaNotice } from "@/lib/telegram-line-quota";

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

  if (input.status === "verified") {
    await notifyLineUserAfterReview({
      slipId: input.slipId,
      status: input.status,
      eventId: slip.event_id,
      slipLineUserId: slip.line_user_id,
      target,
      reason: input.reason,
      actor: input.actor
    }).catch(async (notifyError) => {
      await supabase.from("audit_logs").insert({
        ...input.actor,
        action: "line_approval_card_failed",
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
  eventId: string | null;
  slipLineUserId?: string | null;
  target: {
    display_name: string;
    amount_due: number;
    selected_line_user_id: string | null;
    events?: { id?: string; name: string } | Array<{ id?: string; name: string }> | null;
  } | null;
  reason?: string | null;
  actor: Actor;
}) {
  const supabase = createServiceClient();
  if (input.status !== "verified" || !input.target) return;

  const settings = await getSettings(["line_push_policy", "telegram_bot_token", "telegram_chat_id"]);
  const eventRow = Array.isArray(input.target.events) ? input.target.events[0] : input.target.events;
  const eventName = eventRow?.name ?? "รายการชำระเงิน";
  const displayName = input.target.display_name;
  const amountDue = Number(input.target.amount_due ?? 0);
  const lineUserDbId = input.target.selected_line_user_id ?? input.slipLineUserId ?? null;

  let result: LineQuotaAwarePushResult = {
    ok: false,
    skipped: true,
    reason: "missing_line_user",
    quotaBefore: null,
    quotaAfter: null,
    error: "ไม่พบ LINE user ของผู้รับ"
  };
  let lineUserId: string | null = null;

  if (lineUserDbId) {
    const { data: lineUser, error: lineUserError } = await supabase
      .from("line_users")
      .select("line_user_id")
      .eq("id", lineUserDbId)
      .maybeSingle();

    if (lineUserError) throw lineUserError;
    lineUserId = lineUser?.line_user_id ?? null;
  }

  if (lineUserId) {
    const message = buildApprovalVerifiedFlex({
      displayName,
      eventName,
      amountDue,
      paidAt: new Date().toISOString(),
      liffMeUrl: liffUri("me")
    });
    result = await pushLineQuotaAware({
      lineUserId,
      messages: [message],
      policy: getLinePushPolicy(settings)
    });
  }

  const action = result.ok
    ? "line_approval_card_sent"
    : result.skipped
      ? "line_approval_card_skipped"
      : "line_approval_card_failed";

  const { error: auditError } = await supabase.from("audit_logs").insert({
    ...input.actor,
    action,
    entity_type: "slip_submission",
    entity_id: input.slipId,
    event_id: input.eventId,
    after_data: {
      status: input.status,
      line_push_result: result,
      slip_line_user_id: input.slipLineUserId ?? null,
      target_line_user_id: input.target.selected_line_user_id ?? null,
      line_user_id: lineUserId,
      event_name: eventName,
      display_name: displayName,
      amount_due: amountDue
    },
    reason: result.reason ?? input.reason ?? null
  });
  if (auditError) throw auditError;

  const telegramNotice = await sendTelegramLineQuotaNotice(settings, {
    result,
    displayName,
    eventName,
    amountDue
  }).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));

  if (!telegramNotice.ok) {
    await supabase.from("audit_logs").insert({
      ...input.actor,
      action: "telegram_line_quota_notice_failed",
      entity_type: "slip_submission",
      entity_id: input.slipId,
      event_id: input.eventId,
      after_data: telegramNotice,
      reason: "ส่งสรุปโควตา LINE เข้า Telegram ไม่สำเร็จ"
    });
  }
}
