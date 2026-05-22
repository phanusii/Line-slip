import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

const ALLOWED_KEYS = ["contact_url"] as const;
type SettingKey = (typeof ALLOWED_KEYS)[number];

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const supabase = createServiceClient();

    const { data } = await supabase
      .from("settings")
      .select("key,value")
      .in("key", ALLOWED_KEYS);

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

    const rows = ALLOWED_KEYS
      .filter((key) => key in body)
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
