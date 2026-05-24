import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { getSettings } from "@/lib/settings";
import { handleTelegramWebhook, TelegramUpdate } from "@/lib/telegram";

export async function POST(request: NextRequest) {
  try {
    const settings = await getSettings(["telegram_webhook_secret"]);
    const secret = settings.telegram_webhook_secret;
    if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
      return NextResponse.json({ error: "invalid telegram secret" }, { status: 401 });
    }

    const update = (await request.json()) as TelegramUpdate;
    await handleTelegramWebhook(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: formatApiError(error) }, { status: 200 });
  }
}

