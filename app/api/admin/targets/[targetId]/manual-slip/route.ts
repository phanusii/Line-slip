import { NextRequest, NextResponse } from "next/server";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { STORAGE_BUCKET } from "@/lib/env";
import { hashImage, normalizeSlipImage } from "@/lib/slips";
import { applySlipStatus } from "@/lib/slip-status";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ targetId: string }> }
) {
  try {
    assertAdmin(request);
    const { targetId } = await context.params;
    const supabase = createServiceClient();

    const { data: target, error: targetError } = await supabase
      .from("payment_targets")
      .select("id,event_id,display_name,amount_due,status")
      .eq("id", targetId)
      .single();

    if (targetError) throw targetError;
    if (target.status === "verified") {
      return NextResponse.json(
        { error: `${target.display_name} ชำระเงินแล้ว ไม่สามารถเพิ่มสลิปซ้ำได้` },
        { status: 409 }
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    let file: FormDataEntryValue | null = null;
    let note = "";

    if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      file = form.get("file");
      note = String(form.get("note") ?? "").trim();
    } else if (contentType.includes("application/json")) {
      const body = await request.json().catch(() => ({})) as { note?: string };
      note = String(body.note ?? "").trim();
    }

    let storagePath: string | null = null;
    let fileSize: number | null = null;

    if (file instanceof File && file.size > 0) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const normalized = await normalizeSlipImage(buffer);
      const imageHash = hashImage(normalized);
      const datePart = new Date().toISOString().replace(/[:.]/g, "-");
      const path = `events/${target.event_id}/admin_manual/${targetId}_${datePart}_${imageHash.slice(0, 12)}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, normalized, { contentType: "image/jpeg", upsert: false });

      if (uploadError) throw uploadError;
      storagePath = path;
      fileSize = normalized.length;
    }

    const { data: slip, error: slipError } = await supabase
      .from("slip_submissions")
      .insert({
        event_id: target.event_id,
        payment_target_id: targetId,
        status: "manual_review",
        amount_expected: target.amount_due,
        storage_path: storagePath,
        storage_bucket: STORAGE_BUCKET,
        file_size: fileSize ?? 0,
        auto_check_status: "admin_manual",
        auto_check_reasons: ["admin_manual_entry"]
      })
      .select("id")
      .single();

    if (slipError) throw slipError;

    await applySlipStatus({
      slipId: slip.id,
      status: "verified",
      reason: note || "แอดมินยืนยันการชำระเงินด้วยตนเอง",
      actor: actorFromRequest(request),
      auditAction: "admin_manual_slip_verify",
      source: "dashboard"
    });

    return NextResponse.json({ ok: true, slipId: slip.id });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
