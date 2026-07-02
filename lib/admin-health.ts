import dns from "node:dns/promises";
import { formatApiError } from "@/lib/api-error";
import { STORAGE_BUCKET } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/server";

type HealthStatus = "ok" | "warning" | "error";

export type HealthCheck = {
  status: HealthStatus;
  message: string;
  detail?: string;
  latencyMs?: number;
};

export type AdminHealthReport = {
  ok: boolean;
  message: string;
  checkedAt: string;
  checks: {
    env: HealthCheck;
    supabaseDns: HealthCheck;
    database: HealthCheck;
    storage: HealthCheck;
    schema: HealthCheck;
  };
};

const requiredEnv = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY"
] as const;

function nowMs() {
  return Date.now();
}

async function withTimeout<T>(label: string, promise: PromiseLike<T>, timeoutMs = 7000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ok(message: string, latencyMs?: number): HealthCheck {
  return { status: "ok", message, latencyMs };
}

function warning(message: string, detail?: string, latencyMs?: number): HealthCheck {
  return { status: "warning", message, detail, latencyMs };
}

function error(message: string, detail?: string, latencyMs?: number): HealthCheck {
  return { status: "error", message, detail, latencyMs };
}

function envCheck(): HealthCheck {
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return error("ตั้งค่า Supabase env ไม่ครบ", missing.join(", "));
  }
  return ok("ตั้งค่า Supabase env ครบ");
}

function supabaseHost() {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

async function dnsCheck(): Promise<HealthCheck> {
  const host = supabaseHost();
  if (!host) return error("Supabase URL ไม่ถูกต้อง", "NEXT_PUBLIC_SUPABASE_URL ต้องเป็น URL เต็ม");

  const startedAt = nowMs();
  try {
    const result = await withTimeout("supabase dns lookup", dns.lookup(host), 5000);
    return ok(`DNS Supabase ใช้งานได้ (${host})`, nowMs() - startedAt);
  } catch (err) {
    return error(`DNS Supabase ใช้งานไม่ได้ (${host})`, formatApiError(err), nowMs() - startedAt);
  }
}

export async function getAdminHealthReport(): Promise<AdminHealthReport> {
  const env = envCheck();
  const supabaseDns = await dnsCheck();

  let database: HealthCheck = warning("ยังไม่ได้ตรวจฐานข้อมูล");
  let storage: HealthCheck = warning("ยังไม่ได้ตรวจ Storage");
  let schema: HealthCheck = warning("ยังไม่ได้ตรวจ schema");

  if (env.status === "error") {
    database = error("ข้ามการตรวจฐานข้อมูล เพราะ env ไม่ครบ");
    storage = error("ข้ามการตรวจ Storage เพราะ env ไม่ครบ");
    schema = error("ข้ามการตรวจ schema เพราะ env ไม่ครบ");
  } else {
    try {
      const supabase = createServiceClient();

      const dbStartedAt = nowMs();
      const settingsResult = await withTimeout(
        "settings table check",
        supabase.from("settings").select("key").limit(1),
        7000
      );
      database = settingsResult.error
        ? error("เชื่อมต่อฐานข้อมูลไม่สำเร็จ", formatApiError(settingsResult.error), nowMs() - dbStartedAt)
        : ok("เชื่อมต่อฐานข้อมูลสำเร็จ", nowMs() - dbStartedAt);

      const schemaStartedAt = nowMs();
      const [eventsResult, targetsResult, slipsResult] = await Promise.allSettled([
        withTimeout("events table check", supabase.from("events").select("id").limit(1), 7000),
        withTimeout("payment_targets table check", supabase.from("payment_targets").select("id").limit(1), 7000),
        withTimeout("slip_submissions table check", supabase.from("slip_submissions").select("id").limit(1), 7000)
      ]);
      const schemaFailures = [eventsResult, targetsResult, slipsResult]
        .map((result) => {
          if (result.status === "rejected") return formatApiError(result.reason);
          if (result.value.error) return formatApiError(result.value.error);
          return null;
        })
        .filter(Boolean);
      schema = schemaFailures.length > 0
        ? error("schema หลักยังไม่พร้อม", schemaFailures.join(" | "), nowMs() - schemaStartedAt)
        : ok("schema หลักพร้อมใช้งาน", nowMs() - schemaStartedAt);

      const storageStartedAt = nowMs();
      const storageResult = await withTimeout(
        "storage bucket check",
        supabase.storage.from(STORAGE_BUCKET).list("", { limit: 1 }),
        7000
      );
      storage = storageResult.error
        ? warning("ตรวจ Storage bucket ไม่สำเร็จ", formatApiError(storageResult.error), nowMs() - storageStartedAt)
        : ok(`Storage bucket "${STORAGE_BUCKET}" พร้อมใช้งาน`, nowMs() - storageStartedAt);
    } catch (err) {
      const reason = formatApiError(err);
      database = error("เชื่อมต่อ Supabase ไม่สำเร็จ", reason);
      storage = warning("ยังตรวจ Storage ไม่ได้ เพราะ Supabase ไม่ตอบ", reason);
      schema = error("ยังตรวจ schema ไม่ได้ เพราะ Supabase ไม่ตอบ", reason);
    }
  }

  const checks = { env, supabaseDns, database, storage, schema };
  const okStatus = Object.values(checks).every((check) => check.status !== "error");

  return {
    ok: okStatus,
    message: okStatus
      ? "ระบบหลักพร้อมใช้งาน"
      : "ระบบเชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจ Supabase Project URL และ Vercel env",
    checkedAt: new Date().toISOString(),
    checks
  };
}
