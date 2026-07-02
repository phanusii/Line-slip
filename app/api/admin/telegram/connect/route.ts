import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { assertAdmin } from "@/lib/auth";
import { appBaseUrl } from "@/lib/line";
import { getSettings } from "@/lib/settings";
import {
  ensureTelegramWebhook,
  getConnectedTelegramChats,
  getTelegramBotInfo,
  signTelegramConnectToken
} from "@/lib/telegram";

export async function POST(request: NextRequest) {
  try {
    const admin = assertAdmin(request);
    const settings = await getSettings();
    if (!settings.telegram_bot_token) {
      return NextResponse.json({ error: "กรุณาบันทึก Telegram Bot Token ก่อน" }, { status: 400 });
    }

    const bot = await getTelegramBotInfo(settings);
    if (!bot.username) {
      return NextResponse.json({ error: "ไม่พบ username ของ Telegram bot" }, { status: 400 });
    }

    await ensureTelegramWebhook(settings);
    const token = signTelegramConnectToken({ adminEmail: admin.email, settings });
    const startUrl = `https://t.me/${bot.username}?start=connect_${encodeURIComponent(token)}`;
    const chats = await getConnectedTelegramChats();

    return NextResponse.json({
      ok: true,
      bot,
      startUrl,
      webhookUrl: `${appBaseUrl()}/api/telegram/webhook`,
      chats
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");

    let hasBotToken = false;
    let chats: Awaited<ReturnType<typeof getConnectedTelegramChats>> = [];
    const warnings: string[] = [];

    try {
      const settings = await getSettings(["telegram_bot_token"]);
      hasBotToken = Boolean(settings.telegram_bot_token);
    } catch (settingsError) {
      warnings.push("telegram_settings_unavailable");
      console.error("telegram_connect_settings_failed", formatApiError(settingsError));
    }

    try {
      chats = await getConnectedTelegramChats();
    } catch (chatsError) {
      warnings.push("telegram_chats_unavailable");
      console.error("telegram_connect_chats_failed", formatApiError(chatsError));
    }

    return NextResponse.json({
      ok: true,
      hasBotToken,
      chats,
      warnings
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("telegram_connect_failed", formatApiError(error));
    return NextResponse.json({
      ok: true,
      hasBotToken: false,
      chats: [],
      warnings: ["telegram_connect_unavailable"]
    });
  }
}
