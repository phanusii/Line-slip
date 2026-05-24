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
      .select("id,display_name,amount_due,status,selected_line_user_id")
      .eq("event_id", eventId)
      .neq("status", "verified")
      .neq("status", "deleted")
      .order("display_name", { ascending: true })
      .limit(500);

    if (error) throw error;

    return NextResponse.json({
      targets: (data ?? []).map((target) => ({
        id: target.id,
        display_name: target.display_name,
        amount_due: Number(target.amount_due),
        status: target.status,
        is_selected: Boolean(target.selected_line_user_id)
      }))
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
