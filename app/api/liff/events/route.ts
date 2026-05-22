import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { requireLineAccessToken } from "@/lib/liff";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    await requireLineAccessToken(request);
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("events")
      .select(
        "id,name,slug,promptpay_id,is_open,archived_at,payment_targets(id,display_name,amount_due,status,selected_line_user_id)"
      )
      .eq("is_open", true)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({
      events: data.map((event) => ({
        id: event.id,
        name: event.name,
        slug: event.slug,
        has_promptpay: Boolean(event.promptpay_id),
        targets: (event.payment_targets ?? [])
          .filter((target) => target.status !== "verified" && target.status !== "deleted")
          .sort((a, b) => a.display_name.localeCompare(b.display_name, "th"))
          .map((target) => ({
            id: target.id,
            display_name: target.display_name,
            amount_due: Number(target.amount_due),
            status: target.status,
            is_selected: Boolean(target.selected_line_user_id)
          }))
      }))
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
