import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { assertAdmin } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const supabase = createServiceClient();
    const { data, count, error } = await supabase
      .from("slip_submissions")
      .select("id,created_at", { count: "exact" })
      .eq("status", "manual_review")
      .is("metadata_deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    return NextResponse.json({
      count: count ?? 0,
      latestSlipId: data?.[0]?.id ?? null,
      latestCreatedAt: data?.[0]?.created_at ?? null
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
