import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { assertAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { sendTelegramTestMessage } from "@/lib/telegram";

export async function POST(request: NextRequest) {
  try {
    assertAdmin(request);
    const settings = await getSettings();
    await sendTelegramTestMessage(settings);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}

