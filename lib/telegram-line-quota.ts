import type { LineMessageQuota } from "@/lib/line";
import type { SettingsMap } from "@/lib/settings";
import { getSlipOkQuota, getSlipOkUsedThisMonth } from "@/lib/slipok";

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

function formatAmount(amount: number) {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQuota(quota?: LineMessageQuota | null) {
  if (!quota) return "ไม่ทราบ";
  if (quota.type === "none") return `ไม่จำกัด (ใช้แล้ว ${quota.used.toLocaleString("th-TH")})`;
  return `เหลือ ${Number(quota.remaining ?? 0).toLocaleString("th-TH")}/${Number(quota.limit ?? 0).toLocaleString("th-TH")} ข้อความ (ใช้แล้ว ${quota.used.toLocaleString("th-TH")})`;
}

async function formatSlipOkQuota(settings: SettingsMap) {
  const [quota, usedThisMonth] = await Promise.all([
    getSlipOkQuota(settings).catch(() => null),
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

async function buildNoticeText(settings: SettingsMap, input: {
  result: ApprovalNoticeResult;
  displayName: string;
  eventName: string;
  amountDue: number;
}) {
  const reason = input.result.reason ? reasonLabels[input.result.reason] ?? input.result.reason : "-";
  const slipOkQuota = await formatSlipOkQuota(settings);
  const statusLine = input.result.ok
    ? "ส่งการ์ด LINE ให้ผู้ใช้แล้ว"
    : input.result.skipped
      ? `ไม่ได้ส่ง LINE: ${reason}`
      : `ส่ง LINE ไม่สำเร็จ: ${reason}`;

  return [
    "อนุมัติสลิปแล้ว",
    statusLine,
    `งาน: ${input.eventName}`,
    `ชื่อ: ${input.displayName}`,
    `ยอด: ${formatAmount(input.amountDue)} บาท`,
    `โควตาก่อนส่ง: ${formatQuota(input.result.quotaBefore)}`,
    `โควตาหลังส่ง: ${formatQuota(input.result.quotaAfter ?? input.result.quotaBefore)}`,
    `โควตา SlipOK: ${slipOkQuota}`,
    input.result.error ? `หมายเหตุ: ${input.result.error}` : null
  ].filter(Boolean).join("\n");
}

export async function sendTelegramLineQuotaNotice(
  settings: SettingsMap,
  input: {
    result: ApprovalNoticeResult;
    displayName: string;
    eventName: string;
    amountDue: number;
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
      text: await buildNoticeText(settings, input)
    })
  });
  const data = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !data?.ok) {
    return { ok: false, error: data?.description ?? `Telegram API error: ${response.status}` };
  }
  return { ok: true };
}
