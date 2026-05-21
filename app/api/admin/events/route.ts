import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("events")
      .select(
        "id,name,slug,is_open,expected_total,created_at,payment_targets(id,status,amount_due),slip_submissions(id,status,file_size,storage_path,file_deleted_at,metadata_deleted_at)"
      )
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({
      events: data.map((event) => {
        const targets = event.payment_targets ?? [];
        const slips = (event.slip_submissions ?? []).filter((slip) => !slip.metadata_deleted_at);
        const paid = targets.filter((target) => target.status === "verified").length;
        const unpaid = targets.filter((target) => target.status !== "verified").length;
        const storageBytes = slips
          .filter((slip) => slip.storage_path && !slip.file_deleted_at)
          .reduce((sum, slip) => sum + Number(slip.file_size ?? 0), 0);

        return {
          id: event.id,
          name: event.name,
          slug: event.slug,
          is_open: event.is_open,
          expected_total: event.expected_total,
          target_count: targets.length,
          paid_count: paid,
          unpaid_count: unpaid,
          slip_count: slips.length,
          storage_bytes: storageBytes
        };
      })
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
