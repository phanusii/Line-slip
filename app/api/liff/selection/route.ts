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
      amount?: number;
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
      .select("id,event_id,display_name,amount_due,amount_entered_at,amount_locked_at,status,selected_line_user_id,events(id,name,slug,amount_mode,promptpay_id,promptpay_type,is_open,archived_at)")
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

    if (target.status === "manual_review") {
      return NextResponse.json(
        {
          error:
            target.selected_line_user_id === lineUser.id
              ? "ระบบได้รับสลิปแล้วและกำลังรอตรวจ ไม่ต้องสร้าง QR หรือส่งสลิปซ้ำ"
              : "รายชื่อนี้ส่งสลิปแล้วและกำลังรอตรวจ กรุณาเลือกรายชื่ออื่น"
        },
        { status: 409 }
      );
    }

    const selectedAt = new Date().toISOString();
    const requestedAmount = Number(body.amount);
    const isPayerEntered = event.amount_mode === "payer_entered";
    const storedAmount = target.amount_due === null ? null : Number(target.amount_due);
    let amount = storedAmount;

    if (isPayerEntered) {
      if (target.amount_locked_at) {
        if (!storedAmount || storedAmount <= 0) {
          return NextResponse.json(
            { error: "ยอดเงินรายการนี้ถูกล็อกแต่ไม่พบยอด กรุณาติดต่อผู้ดูแล" },
            { status: 409 }
          );
        }
        if (
          Number.isFinite(requestedAmount) &&
          requestedAmount > 0 &&
          requestedAmount !== storedAmount
        ) {
          return NextResponse.json(
            { error: "ยอดเงินถูกล็อกหลังรับสลิปแล้ว ไม่สามารถเปลี่ยนยอดได้" },
            { status: 409 }
          );
        }
        amount = storedAmount;
      } else {
        if (
          !Number.isInteger(requestedAmount) ||
          requestedAmount < 1 ||
          requestedAmount > 9_999_999
        ) {
          return NextResponse.json(
            { error: "กรุณาระบุยอดเต็มบาทตั้งแต่ 1 ถึง 9,999,999 บาท" },
            { status: 400 }
          );
        }
        amount = requestedAmount;
      }
    }

    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "ยอดเงินสำหรับสร้าง QR ไม่ถูกต้อง" }, { status: 400 });
    }

    const updated = await supabase
      .from("payment_targets")
      .update({
        selected_line_user_id: lineUser.id,
        amount_due: amount,
        amount_entered_at: isPayerEntered ? selectedAt : target.amount_entered_at,
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
        { error: "รายชื่อนี้ไม่พร้อมให้เลือก กรุณาเลือกรายชื่ออื่น" },
        { status: 409 }
      );
    }

    const previousSelections = await supabase
      .from("payment_targets")
      .select("id,amount_locked_at,events(amount_mode)")
      .eq("event_id", target.event_id)
      .eq("selected_line_user_id", lineUser.id)
      .neq("id", target.id)
      .in("status", ["pending_slip", "rejected", "amount_mismatch"]);
    if (previousSelections.error) throw previousSelections.error;

    const cleared = await supabase
      .from("payment_targets")
      .update({ selected_line_user_id: null, status: "unpaid" })
      .eq("event_id", target.event_id)
      .eq("selected_line_user_id", lineUser.id)
      .neq("id", target.id)
      .in("status", ["pending_slip", "rejected", "amount_mismatch"]);

    if (cleared.error) throw cleared.error;

    const variablePreviousIds = (previousSelections.data ?? [])
      .filter((previous) => {
        const previousEvent = Array.isArray(previous.events) ? previous.events[0] : previous.events;
        return previousEvent?.amount_mode === "payer_entered" && !previous.amount_locked_at;
      })
      .map((previous) => previous.id);
    if (variablePreviousIds.length) {
      const resetAmounts = await supabase
        .from("payment_targets")
        .update({ amount_due: null, amount_entered_at: null })
        .in("id", variablePreviousIds)
        .is("amount_locked_at", null);
      if (resetAmounts.error) throw resetAmounts.error;
    }

    if (isPayerEntered) {
      const totals = await supabase
        .from("payment_targets")
        .select("amount_due")
        .eq("event_id", target.event_id)
        .neq("status", "deleted");
      if (totals.error) throw totals.error;

      const expectedTotal = (totals.data ?? []).reduce(
        (sum, paymentTarget) => sum + Number(paymentTarget.amount_due ?? 0),
        0
      );
      const eventTotal = await supabase
        .from("events")
        .update({ expected_total: expectedTotal })
        .eq("id", target.event_id);
      if (eventTotal.error) throw eventTotal.error;
    }

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
        name: event.name,
        amount_mode: event.amount_mode
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
