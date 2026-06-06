// Edge runtime: ~0 ms cold start vs ~300–800 ms for Node Lambda.
// This route only uses fetch + Supabase JS (no native binaries).
export const runtime = "edge";

import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { requireLineAccessToken } from "@/lib/liff";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    await requireLineAccessToken(request);
    const eventId = request.nextUrl.searchParams.get("eventId");

    if (!eventId) {
      return NextResponse.json({ error: "ไม่พบรหัสงาน" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("payment_targets")
      .select("id,display_name,amount_due,amount_locked_at,status,selected_line_user_id,sort_order,created_at")
      .eq("event_id", eventId)
      .neq("status", "deleted")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) throw error;

    return NextResponse.json({
      targets: (data ?? []).map((target, idx) => ({
        id: target.id,
        order: target.sort_order ?? idx + 1,
        display_name: target.display_name,
        amount_due: target.amount_due === null ? null : Number(target.amount_due),
        amount_locked: Boolean(target.amount_locked_at),
        status: target.status,
        is_selected: Boolean(target.selected_line_user_id)
      }))
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
