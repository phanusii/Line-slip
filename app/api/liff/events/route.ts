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
    const supabase = createServiceClient();
    const light = request.nextUrl.searchParams.get("light") === "1";

    if (light) {
      const { data, error } = await supabase
        .from("events")
        .select("id,name,slug,promptpay_id,is_open,archived_at")
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
          targets: []
        }))
      });
    }

    const { data, error } = await supabase
      .from("events")
      .select(
        "id,name,slug,promptpay_id,is_open,archived_at,payment_targets(id,display_name,amount_due,status,selected_line_user_id,created_at)"
      )
      .eq("is_open", true)
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({
      events: data.map((event) => {
        // เรียงตาม created_at จากเก่าไปใหม่ เพื่อรักษาลำดับที่สร้าง
        const sorted = (event.payment_targets ?? [])
          .filter((target) => target.status !== "verified" && target.status !== "deleted")
          .sort((a, b) =>
            new Date(a.created_at as string).getTime() - new Date(b.created_at as string).getTime()
          );
        return {
          id: event.id,
          name: event.name,
          slug: event.slug,
          has_promptpay: Boolean(event.promptpay_id),
          targets: sorted.map((target, idx) => ({
            id: target.id,
            order: idx + 1,
            display_name: target.display_name,
            amount_due: Number(target.amount_due),
            status: target.status,
            is_selected: Boolean(target.selected_line_user_id)
          }))
        };
      })
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
