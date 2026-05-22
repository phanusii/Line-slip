import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { SETTING_KEYS, SettingKey } from "@/lib/settings";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const supabase = createServiceClient();

    const { data } = await supabase
      .from("settings")
      .select("key,value")
      .in("key", SETTING_KEYS);

    const settings = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));
    return NextResponse.json({ settings });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertAdmin(request);
    const body = (await request.json()) as Partial<Record<SettingKey, string>>;
    const supabase = createServiceClient();

    const rows = SETTING_KEYS
      .filter((key) => key in body)
      .filter((key) => {
        const value = body[key];
        return !(isSecretKey(key) && (value === undefined || value === ""));
      })
      .map((key) => ({ key, value: String(body[key] ?? ""), updated_at: new Date().toISOString() }));

    if (!rows.length) {
      return NextResponse.json({ error: "ไม่มีค่าที่จะบันทึก" }, { status: 400 });
    }

    const { error } = await supabase
      .from("settings")
      .upsert(rows, { onConflict: "key" });

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}

function isSecretKey(key: SettingKey) {
  return key === "telegram_bot_token" || key === "admin_review_token_secret";
}
