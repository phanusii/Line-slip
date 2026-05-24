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
    const settings = await getSettings(["telegram_bot_token"]);
    const chats = await getConnectedTelegramChats();
    return NextResponse.json({
      ok: true,
      hasBotToken: Boolean(settings.telegram_bot_token),
      chats
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
