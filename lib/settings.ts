import { createServiceClient } from "@/lib/supabase/server";

export const SETTING_KEYS = [
  "contact_url",
  "line_push_policy",
  "admin_review_channel",
  "telegram_bot_token",
  "telegram_chat_id",
  "discord_webhook_url",
  "admin_review_token_secret",
  "admin_review_token_ttl_hours"
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingsMap = Partial<Record<SettingKey, string>>;

export async function getSettings(keys: readonly SettingKey[] = SETTING_KEYS) {
  const supabase = createServiceClient();
  const { data, error } = await supabase.from("settings").select("key,value").in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((row) => [row.key, row.value])) as SettingsMap;
}

export function getLinePushPolicy(settings: SettingsMap) {
  return settings.line_push_policy === "disabled" ? "disabled" : "quota_aware";
}

export function getAdminReviewChannel(settings: SettingsMap) {
  if (settings.admin_review_channel === "telegram" || settings.admin_review_channel === "discord") {
    return settings.admin_review_channel;
  }
  return "dashboard_only";
}
