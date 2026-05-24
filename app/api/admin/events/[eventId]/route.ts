import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> }
) {
  try {
    assertAdmin(request, "viewer");
    const { eventId } = await context.params;
    const supabase = createServiceClient();

    const [event, targets, slips] = await Promise.all([
      supabase.from("events").select("*").eq("id", eventId).single(),
      supabase
        .from("payment_targets")
        .select("*")
        .eq("event_id", eventId)
        .order("created_at", { ascending: true }),
      supabase
        .from("slip_submissions")
        .select("*")
        .eq("event_id", eventId)
        .is("metadata_deleted_at", null)
        .order("created_at", { ascending: false })
    ]);

    if (event.error) throw event.error;
    if (targets.error) throw targets.error;
    if (slips.error) throw slips.error;

    const signedUrls = new Map<string, string>();
    const pathsByBucket = new Map<string, string[]>();
    for (const slip of slips.data) {
      if (!slip.storage_path || slip.file_deleted_at) continue;
      const bucketPaths = pathsByBucket.get(slip.storage_bucket) ?? [];
      bucketPaths.push(slip.storage_path);
      pathsByBucket.set(slip.storage_bucket, bucketPaths);
    }

    await Promise.all(
      Array.from(pathsByBucket.entries()).map(async ([bucket, paths]) => {
        const signed = await supabase.storage.from(bucket).createSignedUrls(paths, 10 * 60);
        if (signed.error) throw signed.error;
        for (const item of signed.data ?? []) {
          if (item.path && item.signedUrl) signedUrls.set(`${bucket}/${item.path}`, item.signedUrl);
        }
      })
    );

    return NextResponse.json({
      event: event.data,
      targets: targets.data,
      slips: slips.data.map((slip) => ({
        ...slip,
        image_url: slip.storage_path
          ? signedUrls.get(`${slip.storage_bucket}/${slip.storage_path}`) ?? null
          : null,
        payment_targets: slip.payment_target_id
          ? {
              display_name:
                targets.data.find((target) => target.id === slip.payment_target_id)
                  ?.display_name ?? "-"
            }
          : null
      }))
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
