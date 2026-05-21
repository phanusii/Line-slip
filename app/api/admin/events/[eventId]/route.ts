import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> }
) {
  try {
    assertAdmin(request);
    const { eventId } = await context.params;
    const supabase = createServiceClient();

    const [event, targets, slips] = await Promise.all([
      supabase.from("events").select("*").eq("id", eventId).single(),
      supabase
        .from("payment_targets")
        .select("*")
        .eq("event_id", eventId)
        .order("display_name"),
      supabase
        .from("slip_submissions")
        .select("*,payment_targets(display_name)")
        .eq("event_id", eventId)
        .is("metadata_deleted_at", null)
        .order("created_at", { ascending: false })
    ]);

    if (event.error) throw event.error;
    if (targets.error) throw targets.error;
    if (slips.error) throw slips.error;

    return NextResponse.json({
      event: event.data,
      targets: targets.data,
      slips: slips.data
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
