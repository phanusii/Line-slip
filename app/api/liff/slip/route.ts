import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { getLineProfile, verifyLineAccessToken } from "@/lib/liff";
import { uploadSlipImage } from "@/lib/slips";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const accessToken = String(form.get("accessToken") ?? "");
    const targetId = String(form.get("targetId") ?? "");
    const file = form.get("file");

    if (!accessToken || !(file instanceof File)) {
      return NextResponse.json({ error: "ข้อมูลสลิปไม่ครบ กรุณาเลือกไฟล์ใหม่" }, { status: 400 });
    }

    await verifyLineAccessToken(accessToken);
    const profile = await getLineProfile(accessToken);
    const supabase = createServiceClient();

    const { data: lineUser, error: lineUserError } = await supabase
      .from("line_users")
      .upsert(
        {
          line_user_id: profile.userId,
          display_name: profile.displayName ?? null,
          picture_url: profile.pictureUrl ?? null,
          last_seen_at: new Date().toISOString()
        },
        { onConflict: "line_user_id" }
      )
      .select("id")
      .single();

    if (lineUserError) throw lineUserError;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount, error: recentError } = await supabase
      .from("slip_submissions")
      .select("id", { count: "exact", head: true })
      .eq("line_user_id", lineUser.id)
      .gte("created_at", oneHourAgo);

    if (recentError) throw recentError;
    if ((recentCount ?? 0) >= 10) {
      return NextResponse.json(
        { error: "ส่งสลิปเกินจำนวนที่อนุญาต กรุณารอสักครู่แล้วส่งใหม่ภายหลัง" },
        { status: 429 }
      );
    }

    let query = supabase
      .from("payment_targets")
      .select("id,event_id,display_name,amount_due,status,events(id,slug,is_open,archived_at)")
      .eq("selected_line_user_id", lineUser.id)
      .neq("status", "deleted")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (targetId) {
      query = query.eq("id", targetId);
    }

    const { data: target, error: targetError } = await query.maybeSingle();
    if (targetError) throw targetError;
    if (!target) {
      return NextResponse.json(
        { error: "ยังไม่พบรายชื่อที่สร้าง QR ไว้ กรุณาเลือกงานและรายชื่อก่อนส่งสลิป" },
        { status: 409 }
      );
    }

    if (target.status === "verified") {
      return NextResponse.json({
        ok: true,
        alreadyVerified: true,
        message: "รายการนี้จ่ายเรียบร้อยแล้ว ไม่ต้องส่งสลิปเพิ่ม"
      });
    }

    const event = Array.isArray(target.events) ? target.events[0] : target.events;
    if (!event || !event.is_open || event.archived_at) {
      return NextResponse.json({ error: "งานนี้ปิดรับสลิปแล้ว" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const slip = await uploadSlipImage({
      eventId: target.event_id,
      eventSlug: event.slug ?? target.event_id,
      paymentTargetId: target.id,
      personName: target.display_name,
      amountExpected: Number(target.amount_due),
      sourceBuffer: buffer,
      mimeType: file.type,
      lineUserDbId: lineUser.id
    });

    return NextResponse.json({
      ok: true,
      slip,
      message:
        slip.status === "duplicate_slip"
          ? "สลิปนี้เคยถูกส่งแล้ว ระบบบันทึกไว้เป็นสลิปซ้ำ ไม่ใช้ยืนยันการจ่าย"
          : slip.status === "verified"
            ? "ตรวจสลิปผ่านอัตโนมัติจากรูปสลิปแล้ว โปรดทราบว่านี่ไม่ใช่การยืนยันจากธนาคาร"
          : "รับสลิปใหม่แล้ว ระบบจะใช้ใบล่าสุดให้แอดมินตรวจ"
    });
  } catch (error) {
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
