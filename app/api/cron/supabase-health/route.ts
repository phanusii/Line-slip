import { NextResponse } from "next/server";
import { getAdminHealthReport } from "@/lib/admin-health";

async function notifyTelegramFailure(message: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!botToken || !chatIds.length) return;

  await Promise.allSettled(
    chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message })
      })
    )
  );
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await getAdminHealthReport();
    if (!report.ok) {
      throw new Error(report.message);
    }

    return NextResponse.json({
      ok: true,
      service: "supabase",
      checks: report.checks,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await notifyTelegramFailure(
      [
        "⚠️ ตรวจฐานข้อมูล Supabase ไม่สำเร็จ",
        `เวลา: ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`,
        `สาเหตุ: ${reason}`,
        "กรุณาเปิด Supabase Dashboard เพื่อตรวจสถานะโปรเจกต์"
      ].join("\n")
    );
    return NextResponse.json(
      { ok: false, service: "supabase", error: reason, checkedAt: new Date().toISOString() },
      { status: 503 }
    );
  }
}
