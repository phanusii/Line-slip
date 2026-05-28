import type { LineMessageQuota } from "@/lib/line";
import crypto from "node:crypto";
import { appBaseUrl } from "@/lib/line";
import { getSettings, type SettingsMap } from "@/lib/settings";
import { getSlipOkQuota, getSlipOkUsedThisMonth } from "@/lib/slipok";
import { createServiceClient } from "@/lib/supabase/server";

type ApprovalNoticeResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string | null;
  error?: string | null;
  quotaBefore?: LineMessageQuota | null;
  quotaAfter?: LineMessageQuota | null;
};

const reasonLabels: Record<string, string> = {
  policy_disabled: "ปิด LINE push policy",
  missing_line_user: "ไม่พบ LINE user ของผู้รับ",
  missing_token: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN",
  quota_check_failed: "เช็กโควตา LINE ไม่สำเร็จ",
  quota_exhausted: "โควตา LINE หมดแล้ว",
  line_push_failed: "LINE push API ส่งไม่สำเร็จ",
  sent: "ส่งการ์ด LINE สำเร็จ"
};

function tokenSecret(settings: SettingsMap) {
  return (
    settings.admin_review_token_secret ||
    process.env.ADMIN_REVIEW_TOKEN_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    "line-slip-review-dev-secret"
  );
}

function signBody(body: string, settings: SettingsMap) {
  return crypto.createHmac("sha256", tokenSecret(settings)).update(body).digest("base64url");
}

function uuidToHex(id: string) {
  return id.replaceAll("-", "").toLowerCase();
}

function signUnpaidTargetsCallback(eventId: string, settings: SettingsMap) {
  const body = `ev:${uuidToHex(eventId)}:targets:unpaid`;
  return `${body}:${signBody(body, settings).slice(0, 8)}`;
}

function formatAmount(amount: number) {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQuota(quota?: LineMessageQuota | null) {
  if (!quota) return "ไม่ทราบ";
  if (quota.type === "none") return `ไม่จำกัด (ใช้แล้ว ${quota.used.toLocaleString("th-TH")})`;
  return `เหลือ ${Number(quota.remaining ?? 0).toLocaleString("th-TH")}/${Number(quota.limit ?? 0).toLocaleString("th-TH")} ข้อความ (ใช้แล้ว ${quota.used.toLocaleString("th-TH")})`;
}

async function formatSlipOkQuota(settings: SettingsMap) {
  const slipOkSettings = await getSettings([
    "slipok_api_key",
    "slipok_branch_id",
    "slipok_log_enabled",
    "slipok_auto_approve_enabled",
    "slip_verification_provider"
  ]);
  const mergedSettings = { ...settings, ...slipOkSettings };
  const [quota, usedThisMonth] = await Promise.all([
    getSlipOkQuota(mergedSettings).catch(() => null),
    getSlipOkUsedThisMonth().catch(() => 0)
  ]);
  if (!quota) return "ไม่ทราบ";
  if (!quota.ok) return `เช็กไม่ได้ (${quota.error ?? "ไม่ทราบสาเหตุ"})`;
  const remaining = quota.remaining ?? quota.quota ?? null;
  const overQuota = Number(quota.overQuota ?? 0);
  return [
    `เหลือ ${remaining === null ? "ไม่ทราบ" : remaining.toLocaleString("th-TH")} สลิป`,
    `ใช้ในระบบเดือนนี้ ${usedThisMonth.toLocaleString("th-TH")} สลิป`,
    overQuota > 0 ? `overQuota ${overQuota.toLocaleString("th-TH")}` : null
  ].filter(Boolean).join(" · ");
}

async function getPaymentSummary(eventId?: string | null) {
  if (!eventId) return null;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("payment_targets")
    .select("status")
    .eq("event_id", eventId)
    .neq("status", "deleted");
  if (error) throw error;

  const total = data?.length ?? 0;
  const paid = (data ?? []).filter((target) => target.status === "verified").length;
  return {
    total,
    paid,
    unpaid: Math.max(0, total - paid)
  };
}

async function buildNoticeText(settings: SettingsMap, input: {
  result: ApprovalNoticeResult;
  displayName: string;
  eventName: string;
  amountDue: number;
  eventId?: string | null;
}) {
  const reason = input.result.reason ? reasonLabels[input.result.reason] ?? input.result.reason : "-";
  const [slipOkQuota, summary] = await Promise.all([
    formatSlipOkQuota(settings),
    getPaymentSummary(input.eventId).catch(() => null)
  ]);
  const statusLine = input.result.ok
    ? "ส่งการ์ด LINE ให้ผู้ใช้เรียบร้อย"
    : input.result.skipped
      ? `ไม่ได้ส่ง LINE: ${reason}`
      : `ส่ง LINE ไม่สำเร็จ: ${reason}`;
  const summaryLine = summary
    ? `📊 สรุปงานนี้: จ่ายแล้ว ${summary.paid.toLocaleString("th-TH")}/${summary.total.toLocaleString("th-TH")} คน · ค้างจ่าย ${summary.unpaid.toLocaleString("th-TH")} คน`
    : "📊 สรุปงานนี้: ยังดึงจำนวนรายชื่อไม่ได้";

  return [
    "✅ อนุมัติสลิปเรียบร้อย",
    "",
    `📌 งาน: ${input.eventName}`,
    `👤 ชื่อ: ${input.displayName}`,
    `💰 ยอดชำระ: ${formatAmount(input.amountDue)} บาท`,
    "",
    summaryLine,
    "",
    `💬 LINE: ${statusLine}`,
    `📨 โควตา LINE หลังส่ง: ${formatQuota(input.result.quotaAfter ?? input.result.quotaBefore)}`,
    `🧾 โควตา SlipOK: ${slipOkQuota}`,
    input.result.error ? `⚠️ หมายเหตุ: ${input.result.error}` : null
  ].filter(Boolean).join("\n");
}

function buildNoticeReplyMarkup(settings: SettingsMap, eventId?: string | null) {
  const inlineKeyboard = [];
  if (eventId) {
    inlineKeyboard.push([
      {
        text: "⏳ ค้างจ่าย",
        callback_data: signUnpaidTargetsCallback(eventId, settings)
      },
      {
        text: "🌐 ดูบนเว็บ",
        url: appBaseUrl()
      }
    ]);
  } else {
    inlineKeyboard.push([
      {
        text: "🌐 ดูบนเว็บ",
        url: appBaseUrl()
      }
    ]);
  }
  return { inline_keyboard: inlineKeyboard };
}

export async function sendTelegramLineQuotaNotice(
  settings: SettingsMap,
  input: {
    result: ApprovalNoticeResult;
    displayName: string;
    eventName: string;
    amountDue: number;
    eventId?: string | null;
  }
) {
  const token = settings.telegram_bot_token;
  const chatId = settings.telegram_chat_id;
  if (!token || !chatId) {
    return { ok: false, skipped: true, error: "Telegram credentials are not configured" };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: await buildNoticeText(settings, input),
      reply_markup: buildNoticeReplyMarkup(settings, input.eventId)
    })
  });
  const data = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !data?.ok) {
    return { ok: false, error: data?.description ?? `Telegram API error: ${response.status}` };
  }
  return { ok: true };
}
