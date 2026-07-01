import { NextRequest, NextResponse } from "next/server";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { STORAGE_BUCKET } from "@/lib/env";
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
      supabase.from("events").select("*").eq("id", eventId).maybeSingle(),
      supabase
        .from("payment_targets")
        .select("*")
        .eq("event_id", eventId)
        .neq("status", "deleted")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("slip_submissions")
        .select("*")
        .eq("event_id", eventId)
        .is("metadata_deleted_at", null)
        .order("created_at", { ascending: false })
    ]);

    if (event.error) throw event.error;
    if (!event.data) {
      return NextResponse.json({ error: "ไม่พบงานนี้ หรืออาจถูกลบไปแล้ว" }, { status: 404 });
    }
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

    await Promise.allSettled(
      Array.from(pathsByBucket.entries()).map(async ([bucket, paths]) => {
        const signed = await supabase.storage.from(bucket).createSignedUrls(paths, 10 * 60);
        if (signed.error) return;
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

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> }
) {
  try {
    assertAdmin(request);
    const { eventId } = await context.params;
    const body = (await request.json()) as { confirmName?: string };
    const supabase = createServiceClient();

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id,name,slug")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) throw eventError;
    if (!event) {
      return NextResponse.json({ ok: true, alreadyDeleted: true, deleted_files: 0 });
    }

    if (!body.confirmName || body.confirmName !== event.name) {
      return NextResponse.json(
        { error: "ชื่องานที่พิมพ์ยืนยันไม่ตรงกับชื่องานจริง" },
        { status: 400 }
      );
    }

    // 1. ดึง storage paths ทั้งหมดก่อนลบ
    const { data: slips, error: slipsError } = await supabase
      .from("slip_submissions")
      .select("id,storage_path,storage_bucket")
      .eq("event_id", eventId);

    if (slipsError) throw slipsError;

    // 2. ลบไฟล์จาก storage
    const storagePaths = (slips ?? [])
      .filter((s) => s.storage_path)
      .map((s) => s.storage_path as string);

    if (storagePaths.length > 0) {
      const removed = await supabase.storage.from(STORAGE_BUCKET).remove(storagePaths);
      if (removed.error) throw removed.error;
    }

    // 3. บันทึก audit log ก่อนลบ (เพื่อประวัติ)
    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "delete_event",
      entity_type: "event",
      entity_id: eventId,
      event_id: eventId,
      before_data: {
        name: event.name,
        slug: event.slug,
        slip_count: slips?.length ?? 0,
        deleted_files: storagePaths.length
      },
      reason: "ลบงานออกจากระบบทั้งหมดโดยผู้ดูแล"
    });

    // 4. ลบข้อมูลจาก DB (ลำดับสำคัญ: child → parent)
    const { error: slipDelError } = await supabase
      .from("slip_submissions")
      .delete()
      .eq("event_id", eventId);
    if (slipDelError) throw slipDelError;

    const { error: targetDelError } = await supabase
      .from("payment_targets")
      .delete()
      .eq("event_id", eventId);
    if (targetDelError) throw targetDelError;

    const { error: eventDelError } = await supabase
      .from("events")
      .delete()
      .eq("id", eventId);
    if (eventDelError) throw eventDelError;

    return NextResponse.json({ ok: true, deleted_files: storagePaths.length });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
