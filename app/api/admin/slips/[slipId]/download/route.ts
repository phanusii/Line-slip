import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { safeFilePart } from "@/lib/format";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slipId: string }> }
) {
  try {
    assertAdmin(request, "viewer");
    const { slipId } = await context.params;
    const supabase = createServiceClient();

    const { data: slip, error } = await supabase
      .from("slip_submissions")
      .select("id,event_id,storage_bucket,storage_path,status,amount_expected,created_at,payment_target_id")
      .eq("id", slipId)
      .single();

    if (error) throw error;
    if (!slip.storage_path) {
      return NextResponse.json({ error: "ไฟล์สลิปนี้ถูกลบแล้ว" }, { status: 404 });
    }

    const target = slip.payment_target_id
      ? await supabase
          .from("payment_targets")
          .select("display_name")
          .eq("id", slip.payment_target_id)
          .single()
      : null;

    const file = await supabase.storage
      .from(slip.storage_bucket)
      .download(slip.storage_path);

    if (file.error) throw file.error;

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "download_slip_file",
      entity_type: "slip_submission",
      entity_id: slipId,
      event_id: slip.event_id
    });

    const person = safeFilePart(target?.data?.display_name ?? "unknown");
    const amount = Number(slip.amount_expected ?? 0).toFixed(2);
    const date = new Date(slip.created_at).toISOString().slice(0, 10);

    return new NextResponse(file.data, {
      headers: {
        "content-type": "image/jpeg",
        "content-disposition": `attachment; filename="${person}_${amount}_${slip.status}_${date}.jpg"`
      }
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
