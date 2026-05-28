import { getBooleanSetting, getSettings, SettingsMap } from "@/lib/settings";
import { createServiceClient } from "@/lib/supabase/server";

const SLIPOK_API_BASE = "https://api.slipok.com/api/line/apikey";
const BANGKOK_TIME_ZONE = "Asia/Bangkok";

export type SlipOkQuotaSnapshot = {
  ok: boolean;
  quota: number | null;
  overQuota: number | null;
  used: number | null;
  remaining: number | null;
  raw: unknown;
  error?: string;
};

export type SlipOkVerifyResult = {
  ok: boolean;
  passed: boolean;
  checkStatus: string;
  reasons: string[];
  amountDetected: number | null;
  reference: string | null;
  raw: unknown;
  error?: string;
};

function slipOkCredentials(settings: SettingsMap) {
  return {
    apiKey: settings.slipok_api_key || process.env.SLIPOK_API_KEY || "",
    branchId: settings.slipok_branch_id || process.env.SLIPOK_BRANCH_ID || ""
  };
}

function authHeaders(apiKey: string) {
  return {
    "x-authorization": apiKey
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getNestedNumber(source: unknown, keys: string[]) {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const direct = toNumber(record[key]);
    if (direct !== null) return direct;
  }
  const data = record.data;
  if (data && typeof data === "object") {
    const dataRecord = data as Record<string, unknown>;
    for (const key of keys) {
      const nested = toNumber(dataRecord[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function getNestedString(source: unknown, keys: string[]) {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  const data = record.data;
  if (data && typeof data === "object") {
    const dataRecord = data as Record<string, unknown>;
    for (const key of keys) {
      if (typeof dataRecord[key] === "string" && dataRecord[key]) return dataRecord[key] as string;
    }
  }
  return null;
}

function slipOkSuccess(source: unknown) {
  if (!source || typeof source !== "object") return false;
  const record = source as Record<string, unknown>;
  if (record.success === true) return true;
  if (record.ok === true) return true;
  const code = toNumber(record.code);
  return code === 200 || code === 1000;
}

function slipOkMessage(source: unknown) {
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  return (
    (typeof record.message === "string" && record.message) ||
    (typeof record.error === "string" && record.error) ||
    (typeof record.description === "string" && record.description) ||
    null
  );
}

export function currentBangkokMonthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? date.getUTCFullYear().toString();
  const month = parts.find((part) => part.type === "month")?.value ?? String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export async function getSlipOkQuota(settings?: SettingsMap) {
  const resolvedSettings = settings ?? await getSettings();
  const { apiKey, branchId } = slipOkCredentials(resolvedSettings);
  if (!apiKey || !branchId) {
    return {
      ok: false,
      quota: null,
      overQuota: null,
      used: null,
      remaining: null,
      raw: null,
      error: "ยังไม่ได้ตั้งค่า SlipOK API Key หรือ Branch ID"
    } satisfies SlipOkQuotaSnapshot;
  }

  const response = await fetch(`${SLIPOK_API_BASE}/${encodeURIComponent(branchId)}/quota`, {
    headers: authHeaders(apiKey),
    cache: "no-store"
  });
  const raw = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));

  const quota = getNestedNumber(raw, ["quota", "remaining", "remainingQuota", "limit"]);
  const overQuota = getNestedNumber(raw, ["overQuota", "over_quota", "over_quota_count"]) ?? 0;
  const used = getNestedNumber(raw, ["used", "usedQuota", "usage", "count"]);
  const remaining = getNestedNumber(raw, ["remaining", "quota", "remainingQuota"]) ?? quota;

  if (!response.ok || (!slipOkSuccess(raw) && quota === null && remaining === null)) {
    return {
      ok: false,
      quota,
      overQuota,
      used,
      remaining,
      raw,
      error: slipOkMessage(raw) ?? `SlipOK quota API error: ${response.status}`
    } satisfies SlipOkQuotaSnapshot;
  }

  return {
    ok: true,
    quota,
    overQuota,
    used,
    remaining,
    raw
  } satisfies SlipOkQuotaSnapshot;
}

export function isSlipOkQuotaExhausted(quota: SlipOkQuotaSnapshot | null | undefined) {
  if (!quota?.ok) return false;
  return Number(quota.remaining ?? quota.quota ?? 1) <= 0 || Number(quota.overQuota ?? 0) > 0;
}

export async function verifySlipWithSlipOk(input: {
  settings: SettingsMap;
  imageBuffer: Buffer;
  amountExpected?: number | null;
}) {
  const { apiKey, branchId } = slipOkCredentials(input.settings);
  if (!apiKey || !branchId) {
    return {
      ok: false,
      passed: false,
      checkStatus: "missing_credentials",
      reasons: ["slipok_missing_credentials"],
      amountDetected: null,
      reference: null,
      raw: null,
      error: "ยังไม่ได้ตั้งค่า SlipOK API Key หรือ Branch ID"
    } satisfies SlipOkVerifyResult;
  }

  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(input.imageBuffer)], { type: "image/jpeg" }), "slip.jpg");
  if (input.amountExpected !== null && input.amountExpected !== undefined) {
    form.append("amount", Number(input.amountExpected).toFixed(2));
  }
  form.append("log", getBooleanSetting(input.settings, "slipok_log_enabled", true) ? "true" : "false");

  const response = await fetch(`${SLIPOK_API_BASE}/${encodeURIComponent(branchId)}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
    cache: "no-store"
  });
  const raw = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));
  const reference = getNestedString(raw, ["transRef", "trans_ref", "transactionRef", "ref", "reference", "slipRef"]);
  const amountDetected = getNestedNumber(raw, ["amount", "transAmount", "trans_amount", "transferAmount"]);
  const amountExpected = input.amountExpected ?? null;
  const amountMatches =
    amountExpected === null ||
    amountDetected === null ||
    Math.round(Number(amountDetected) * 100) === Math.round(Number(amountExpected) * 100);
  const apiPassed = response.ok && slipOkSuccess(raw);
  const passed = apiPassed && amountMatches;
  const reasons: string[] = [];

  if (!response.ok) reasons.push("slipok_api_error");
  if (response.ok && !apiPassed) reasons.push("slipok_rejected");
  if (apiPassed && !amountMatches) reasons.push("slipok_amount_mismatch");
  if (passed) reasons.push("slipok_verified");

  return {
    ok: response.ok,
    passed,
    checkStatus: passed ? "passed" : "manual_review",
    reasons,
    amountDetected,
    reference,
    raw,
    error: passed ? undefined : slipOkMessage(raw) ?? undefined
  } satisfies SlipOkVerifyResult;
}

export async function recordSlipOkUsage(input: {
  slipId?: string | null;
  quotaBefore?: SlipOkQuotaSnapshot | null;
  quotaAfter?: SlipOkQuotaSnapshot | null;
  providerStatus: string;
}) {
  const supabase = createServiceClient();
  const beforeRemaining = input.quotaBefore?.remaining ?? input.quotaBefore?.quota ?? null;
  const afterRemaining = input.quotaAfter?.remaining ?? input.quotaAfter?.quota ?? null;
  const delta =
    beforeRemaining !== null && afterRemaining !== null
      ? Math.max(0, Number(beforeRemaining) - Number(afterRemaining))
      : input.providerStatus === "skipped_quota_exhausted"
        ? 0
        : 1;

  await supabase.from("slipok_usage_logs").insert({
    slip_id: input.slipId ?? null,
    month_key: currentBangkokMonthKey(),
    quota_before: beforeRemaining,
    quota_after: afterRemaining,
    over_quota: input.quotaAfter?.overQuota ?? input.quotaBefore?.overQuota ?? null,
    used_delta: delta || (input.providerStatus === "skipped_quota_exhausted" ? 0 : 1),
    provider_status: input.providerStatus
  });
}

export async function getSlipOkUsedThisMonth(monthKey = currentBangkokMonthKey()) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("slipok_usage_logs")
    .select("used_delta")
    .eq("month_key", monthKey);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.used_delta ?? 0), 0);
}

export async function disableSlipOkToManual(reason: string) {
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { error: settingsError } = await supabase.from("settings").upsert(
    [
      { key: "slip_verification_provider", value: "manual", updated_at: now },
      { key: "slipok_disabled_reason", value: reason, updated_at: now },
      { key: "slipok_disabled_at", value: now, updated_at: now }
    ],
    { onConflict: "key" }
  );
  if (settingsError) throw settingsError;

  await supabase.from("audit_logs").insert({
    actor_email: "system-slipok",
    actor_role: "viewer",
    action: "slipok_auto_disabled_quota_exhausted",
    entity_type: "settings",
    after_data: { reason, disabled_at: now },
    reason
  });

  const settings = await getSettings(["telegram_bot_token", "telegram_chat_id"]);
  await sendSlipOkTelegramNotice(settings, [
    "SlipOK ถูกปิดอัตโนมัติ",
    `เหตุผล: ${reason}`,
    "ระบบจะกลับไปใช้ Manual review ผ่าน Telegram/Dashboard จนกว่าแอดมินจะเปิด SlipOK ใหม่"
  ].join("\n")).catch((error) => {
    console.error("slipok telegram notice failed", error);
  });
}

export async function sendSlipOkTelegramNotice(settings: SettingsMap, text: string) {
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) {
    return { ok: false, skipped: true, error: "Telegram credentials are not configured" };
  }

  const response = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: settings.telegram_chat_id,
      text
    })
  });
  const data = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !data?.ok) {
    return { ok: false, error: data?.description ?? `Telegram API error: ${response.status}` };
  }
  return { ok: true };
}
