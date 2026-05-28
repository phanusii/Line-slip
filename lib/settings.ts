import { createServiceClient } from "@/lib/supabase/server";

export const SETTING_KEYS = [
  "contact_url",
  "line_push_policy",
  "admin_review_channel",
  "telegram_bot_token",
  "telegram_chat_id",
  "telegram_webhook_secret",
  "discord_webhook_url",
  "admin_review_token_secret",
  "admin_review_token_ttl_hours",
  "auto_verify_from_slip_enabled",
  "auto_verify_window_hours",
  "auto_verify_requires_unique_amount",
  "auto_verify_ocr_enabled",
  "auto_verify_ocr_min_confidence",
  "slip_verification_provider",
  "slipok_api_key",
  "slipok_branch_id",
  "slipok_log_enabled",
  "slipok_auto_approve_enabled",
  "slipok_disabled_reason",
  "slipok_disabled_at"
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingsMap = Partial<Record<SettingKey, string>>;

/**
 * env var fallbacks — ถ้า admin ตั้ง env var บน Vercel แต่ยังไม่บันทึกใน settings table
 * ระบบจะ fallback ให้อัตโนมัติ (DB value มีสิทธิ์สูงกว่า)
 */
const ENV_FALLBACKS: Partial<Record<SettingKey, string | undefined>> = {
  telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN,
  telegram_chat_id: process.env.TELEGRAM_CHAT_ID,
  discord_webhook_url: process.env.DISCORD_WEBHOOK_URL,
  slipok_api_key: process.env.SLIPOK_API_KEY,
  slipok_branch_id: process.env.SLIPOK_BRANCH_ID
};

export async function getSettings(keys: readonly SettingKey[] = SETTING_KEYS) {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from("settings").select("key,value").in("key", keys);
  if (error) throw error;
  const dbSettings = Object.fromEntries((data ?? []).map((row) => [row.key, row.value])) as SettingsMap;
  // env var fallbacks: ใช้เฉพาะ key ที่ขอและ DB ยังไม่มี
  for (const key of keys) {
    const envValue = ENV_FALLBACKS[key];
    if (envValue && !dbSettings[key]) {
      dbSettings[key] = envValue;
    }
  }
  return dbSettings;
}

export function getLinePushPolicy(settings: SettingsMap) {
  return settings.line_push_policy === "quota_aware" ? "quota_aware" : "disabled";
}

export function getAdminReviewChannel(settings: SettingsMap) {
  if (settings.admin_review_channel === "telegram" || settings.admin_review_channel === "discord") {
    return settings.admin_review_channel;
  }
  // Auto-upgrade: ถ้ามี Telegram credentials ครบ ส่ง Telegram เสมอ
  // แม้ admin จะไม่ได้เปลี่ยน admin_review_channel ผ่าน UI
  if (settings.telegram_bot_token && settings.telegram_chat_id) {
    return "telegram";
  }
  return "dashboard_only";
}

export function getSlipVerificationProvider(settings: SettingsMap) {
  return settings.slip_verification_provider === "slipok" ? "slipok" : "manual";
}

export function getBooleanSetting(settings: SettingsMap, key: SettingKey, defaultValue = false) {
  const value = settings[key];
  if (value === undefined || value === "") return defaultValue;
  return value === "true" || value === "1" || value === "enabled";
}

export function getNumberSetting(settings: SettingsMap, key: SettingKey, defaultValue: number) {
  const value = Number(settings[key]);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}
