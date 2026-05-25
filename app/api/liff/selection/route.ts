import QRCode from "qrcode";
import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { verifyAndGetProfile } from "@/lib/liff";
import { buildPromptPayPayload } from "@/lib/promptpay";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      accessToken?: string;
      eventId?: string;
      targetId?: string;
    };

    if (!body.accessToken || !body.eventId || !body.targetId) {
      return NextResponse.json(
        { error: "ข้อมูลการเลือกไม่ครบ กรุณาเปิดจาก LINE แล้วเลือกใหม่อีกครั้ง" },
        { status: 400 }
      );
    }

    const profile = await verifyAndGetProfile(body.accessToken);
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

    const { data: target, error: targetError } = await supabase
      .from("payment_targets")
      .select("id,event_id,display_name,amount_due,status,selected_line_user_id,events(id,name,slug,promptpay_id,promptpay_type,is_open,archived_at)")
      .eq("id", body.targetId)
      .eq("event_id", body.eventId)
      .single();

    if (targetError) throw targetError;

    const event = Array.isArray(target.events) ? target.events[0] : target.events;
    if (!event || !event.is_open || event.archived_at) {
      return NextResponse.json({ error: "งานนี้ปิดรับสลิปแล้ว" }, { status: 400 });
    }

    if (!event.promptpay_id) {
      return NextResponse.json(
        { error: "งานนี้ยังไม่ได้ตั้งค่า PromptPay ID สำหรับสร้าง QR Code" },
        { status: 400 }
      );
    }

    if (target.status === "verified" || target.status === "deleted") {
      return NextResponse.json({ error: "รายชื่อนี้ชำระเงินแล้วหรือไม่พร้อมใช้งาน" }, { status: 400 });
    }

    const selectedAt = new Date().toISOString();
    const updated = await supabase
      .from("payment_targets")
      .update({
        selected_line_user_id: lineUser.id,
        status: "pending_slip",
        updated_at: selectedAt
      })
      .eq("id", target.id)
      .eq("event_id", target.event_id)
      .neq("status", "verified")
      .neq("status", "deleted")
      .or(`selected_line_user_id.is.null,selected_line_user_id.eq.${lineUser.id}`)
      .select("id")
      .maybeSingle();

    if (updated.error) throw updated.error;

    if (!updated.data) {
      return NextResponse.json(
        { error: "รายชื่อนี้ถูกเลือกไว้แล้ว หากเลือกผิดให้ติดต่อผู้ดูแล" },
        { status: 409 }
      );
    }

    const cleared = await supabase
      .from("payment_targets")
      .update({ selected_line_user_id: null, status: "unpaid" })
      .eq("event_id", target.event_id)
      .eq("selected_line_user_id", lineUser.id)
      .neq("id", target.id)
      .neq("status", "verified");

    if (cleared.error) throw cleared.error;

    const amount = Number(target.amount_due);

    const payload = buildPromptPayPayload(event.promptpay_id, amount, event.promptpay_type);
    const qrDataUrl = await QRCode.toDataURL(payload, {
      margin: 1,
      width: 720,
      color: {
        dark: "#202840",
        light: "#ffffff"
      }
    });

    await supabase.from("audit_logs").insert({
      actor_email: profile.displayName ?? profile.userId,
      actor_role: "viewer",
      action: "liff_select_payment_target",
      entity_type: "payment_target",
      entity_id: target.id,
      event_id: target.event_id,
      after_data: {
        line_user_id: profile.userId,
        display_name: target.display_name,
        amount_due: amount
      },
      reason: "ผู้ใช้เลือกงานและรายชื่อผ่าน LIFF"
    });

    return NextResponse.json({
      event: {
        id: event.id,
        name: event.name
      },
      target: {
        id: target.id,
        display_name: target.display_name,
        amount_due: amount
      },
      qr: {
        data_url: qrDataUrl,
        payload
      }
    });
  } catch (error) {
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
