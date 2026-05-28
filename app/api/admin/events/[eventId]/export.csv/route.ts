import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { statusLabels } from "@/lib/status";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> }
) {
  try {
    assertAdmin(request);
    const { eventId } = await context.params;
    const supabase = createServiceClient();

    const [event, targets] = await Promise.all([
      supabase.from("events").select("name,slug").eq("id", eventId).single(),
      supabase
        .from("payment_targets")
        .select("display_name,amount_due,status,paid_at,note")
        .eq("event_id", eventId)
        .neq("status", "deleted")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true })
    ]);

    if (event.error) throw event.error;
    if (targets.error) throw targets.error;

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "download_event_csv",
      entity_type: "event",
      entity_id: eventId,
      event_id: eventId
    });

    const header = ["ชื่อ", "ยอดที่ต้องจ่าย", "สถานะ", "เวลาจ่าย", "หมายเหตุ"];
    const rows = targets.data.map((target) => [
      target.display_name,
      target.amount_due,
      statusLabels[target.status] ?? target.status,
      target.paid_at ?? "",
      target.note ?? ""
    ]);

    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");

    return new NextResponse(`\uFEFF${csv}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${event.data.slug}-payments.csv"`
      }
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
