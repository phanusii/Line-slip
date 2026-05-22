import crypto from "node:crypto";
import { appBaseUrl } from "@/lib/line";
import { getAdminReviewChannel, getSettings, SettingsMap } from "@/lib/settings";
import { createServiceClient } from "@/lib/supabase/server";

type ReviewAction = "verified" | "rejected";

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function tokenSecret(settings: SettingsMap) {
  return (
    settings.admin_review_token_secret ||
    process.env.ADMIN_REVIEW_TOKEN_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    "line-slip-review-dev-secret"
  );
}

export function signExternalReviewToken(input: {
  slipId: string;
  action: ReviewAction;
  settings: SettingsMap;
}) {
  const ttlHours = Number(input.settings.admin_review_token_ttl_hours || 24);
  const payload = {
    slipId: input.slipId,
    action: input.action,
    exp: Date.now() + Math.max(1, ttlHours) * 60 * 60 * 1000
  };
  const body = base64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", tokenSecret(input.settings))
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export async function verifyExternalReviewToken(input: {
  token: string;
  slipId: string;
  action: ReviewAction;
}) {
  const settings = await getSettings(["admin_review_token_secret", "admin_review_token_ttl_hours"]);
  const [body, signature] = input.token.split(".");
  if (!body || !signature) throw new Error("ลิงก์ตรวจสลิปไม่ถูกต้อง");

  const expected = crypto
    .createHmac("sha256", tokenSecret(settings))
    .update(body)
    .digest("base64url");

  const actualSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(expected);
  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("ลิงก์ตรวจสลิปไม่ถูกต้อง");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    slipId: string;
    action: ReviewAction;
    exp: number;
  };

  if (payload.slipId !== input.slipId || payload.action !== input.action) {
    throw new Error("ลิงก์ตรวจสลิปไม่ตรงกับรายการนี้");
  }
  if (Date.now() > payload.exp) {
    throw new Error("ลิงก์ตรวจสลิปหมดอายุแล้ว กรุณาตรวจจาก dashboard");
  }
}

export async function notifyAdminSlipReview(slipId: string) {
  const settings = await getSettings();
  const channel = getAdminReviewChannel(settings);
  if (channel === "dashboard_only") return;

  const supabase = createServiceClient();
  const { data: slip, error } = await supabase
    .from("slip_submissions")
    .select("*")
    .eq("id", slipId)
    .single();
  if (error) throw error;
  if (slip.status !== "manual_review") return;

  const { data: target } = slip.payment_target_id
    ? await supabase
        .from("payment_targets")
        .select("display_name,amount_due,events(name)")
        .eq("id", slip.payment_target_id)
        .maybeSingle()
    : { data: null };

  let imageUrl: string | null = null;
  if (slip.storage_path) {
    const signed = await supabase.storage
      .from(slip.storage_bucket)
      .createSignedUrl(slip.storage_path, 24 * 60 * 60);
    imageUrl = signed.data?.signedUrl ?? null;
  }

  const verifiedUrl = externalReviewUrl(slipId, "verified", settings);
  const rejectedUrl = externalReviewUrl(slipId, "rejected", settings);
  const eventRow = Array.isArray(target?.events) ? target?.events[0] : target?.events;
  const eventName = eventRow?.name ?? "ไม่พบชื่องาน";
  const displayName = target?.display_name ?? "ไม่พบชื่อ";
  const amount = Number(target?.amount_due ?? slip.amount_expected ?? 0).toLocaleString("th-TH");
  const message = [
    "มีสลิปใหม่รอตรวจ",
    `งาน: ${eventName}`,
    `ชื่อ: ${displayName}`,
    `ยอด: ${amount} บาท`,
    `เวลา: ${new Date(slip.created_at).toLocaleString("th-TH")}`
  ].join("\n");

  try {
    if (channel === "telegram") {
      await sendTelegramReview(settings, message, imageUrl, verifiedUrl, rejectedUrl);
    } else {
      await sendDiscordReview(settings, message, imageUrl, verifiedUrl, rejectedUrl);
    }

    await supabase.from("audit_logs").insert({
      actor_email: "system",
      actor_role: "viewer",
      action: "admin_review_message_sent",
      entity_type: "slip_submission",
      entity_id: slipId,
      event_id: slip.event_id,
      after_data: { channel },
      reason: "แจ้งแอดมินให้ตรวจสลิปใหม่"
    });
  } catch (error) {
    await supabase.from("audit_logs").insert({
      actor_email: "system",
      actor_role: "viewer",
      action: "admin_review_message_failed",
      entity_type: "slip_submission",
      entity_id: slipId,
      event_id: slip.event_id,
      after_data: { channel, error: error instanceof Error ? error.message : String(error) },
      reason: "แจ้งแอดมินให้ตรวจสลิปใหม่ไม่สำเร็จ"
    });
  }
}

function externalReviewUrl(slipId: string, action: ReviewAction, settings: SettingsMap) {
  const token = signExternalReviewToken({ slipId, action, settings });
  return `${appBaseUrl()}/api/admin/slips/${slipId}/external-review?action=${action}&token=${encodeURIComponent(token)}`;
}

async function sendTelegramReview(
  settings: SettingsMap,
  text: string,
  imageUrl: string | null,
  verifiedUrl: string,
  rejectedUrl: string
) {
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) {
    throw new Error("ยังไม่ได้ตั้งค่า Telegram bot token/chat id");
  }

  const endpoint = imageUrl ? "sendPhoto" : "sendMessage";
  const payload = imageUrl
    ? {
        chat_id: settings.telegram_chat_id,
        photo: imageUrl,
        caption: text,
        reply_markup: {
          inline_keyboard: [[
            { text: "อนุมัติ", url: verifiedUrl },
            { text: "ปฏิเสธ", url: rejectedUrl }
          ]]
        }
      }
    : {
        chat_id: settings.telegram_chat_id,
        text,
        reply_markup: {
          inline_keyboard: [[
            { text: "อนุมัติ", url: verifiedUrl },
            { text: "ปฏิเสธ", url: rejectedUrl }
          ]]
        }
      };

  const response = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(await response.text());
}

async function sendDiscordReview(
  settings: SettingsMap,
  text: string,
  imageUrl: string | null,
  verifiedUrl: string,
  rejectedUrl: string
) {
  if (!settings.discord_webhook_url) throw new Error("ยังไม่ได้ตั้งค่า Discord webhook URL");

  const response = await fetch(settings.discord_webhook_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `${text}\n\nอนุมัติ: ${verifiedUrl}\nปฏิเสธ: ${rejectedUrl}`,
      embeds: imageUrl ? [{ image: { url: imageUrl } }] : []
    })
  });

  if (!response.ok) throw new Error(await response.text());
}
