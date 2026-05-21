import { NextRequest, NextResponse } from "next/server";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slipId: string }> }
) {
  try {
    assertAdmin(request);
    const { slipId } = await context.params;
    const supabase = createServiceClient();

    const { data: slip, error } = await supabase
      .from("slip_submissions")
      .select("id,event_id,storage_bucket,storage_path")
      .eq("id", slipId)
      .single();

    if (error) throw error;
    if (!slip.storage_path) {
      return NextResponse.json({ error: "Slip file has been deleted." }, { status: 404 });
    }

    const signed = await supabase.storage
      .from(slip.storage_bucket)
      .createSignedUrl(slip.storage_path, 10 * 60);

    if (signed.error) throw signed.error;

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "view_slip_signed_url",
      entity_type: "slip_submission",
      entity_id: slipId,
      event_id: slip.event_id
    });

    return NextResponse.json({ signedUrl: signed.data.signedUrl });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
