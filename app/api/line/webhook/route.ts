import { NextRequest, NextResponse } from "next/server";
import {
  buildNoPaymentStatusFlex,
  buildPaymentStatusFlex,
  buildStatusFlexMessage,
  lineMenuMessages,
  liffUri,
  replyLine,
  verifyLineSignature
} from "@/lib/line";
import { downloadLineContent, uploadSlipImage } from "@/lib/slips";
import { createServiceClient } from "@/lib/supabase/server";

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { id: string; type: string; text?: string };
  postback?: { data: string; displayText?: string };
};

async function buildUserStatusMessages(
  supabase: ReturnType<typeof createServiceClient>,
  lineUserId?: string
) {
  if (!lineUserId) {
    return [buildNoPaymentStatusFlex(liffUri("pay"))];
  }

  const { data: lineUser } = await supabase
    .from("line_users")
    .select("id")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (!lineUser) {
    return [buildNoPaymentStatusFlex(liffUri("pay"))];
  }

  const { data: targets, error: targetsError } = await supabase
    .from("payment_targets")
    .select("id,display_name,amount_due,status,paid_at,updated_at,events(id,name,is_open,archived_at)")
    .eq("selected_line_user_id", lineUser.id)
    .neq("status", "deleted")
    .order("updated_at", { ascending: false })
    .limit(10);

  if (targetsError) throw targetsError;
  if (!targets?.length) {
    return [buildNoPaymentStatusFlex(liffUri("pay"))];
  }

  const targetIds = targets.map((target) => target.id);
  const { data: slips, error: slipsError } = await supabase
    .from("slip_submissions")
    .select("payment_target_id,status,created_at,metadata_deleted_at")
    .in("payment_target_id", targetIds)
    .is("metadata_deleted_at", null)
    .order("created_at", { ascending: false });

  if (slipsError) throw slipsError;

  const bubbles = targets.flatMap((target) => {
    const eventRow = Array.isArray(target.events) ? target.events[0] : target.events;
    if (!eventRow || eventRow.archived_at || !eventRow.is_open) return [];
    const latestSlip = (slips ?? []).find((slip) => slip.payment_target_id === target.id);
    const displayStatus =
      target.status === "verified"
        ? "verified"
        : latestSlip?.status === "rejected" || latestSlip?.status === "duplicate_slip"
          ? latestSlip.status
          : latestSlip
            ? "manual_review"
            : target.status;

    return [
      buildPaymentStatusFlex({
        displayName: target.display_name,
        eventName: eventRow.name ?? "",
        amountDue: Number(target.amount_due),
        status: displayStatus,
        paidAt: target.paid_at ?? null,
        latestSlipAt: latestSlip?.created_at ?? null,
        liffPayUrl: liffUri("pay"),
        liffSlipUrl: liffUri("slip")
      })
    ];
  });

  return [bubbles.length ? buildStatusFlexMessage(bubbles) : buildNoPaymentStatusFlex(liffUri("pay"))];
}

async function replyUserStatus(
  supabase: ReturnType<typeof createServiceClient>,
  replyToken: string,
  lineUserId?: string
) {
  try {
    await replyLine(replyToken, await buildUserStatusMessages(supabase, lineUserId));
  } catch (error) {
    console.error("LINE status reply failed", error);
    await replyLine(replyToken, [
      {
        type: "text",
        text: "ยังแสดงการ์ดสถานะไม่ได้ในตอนนี้ กรุณากดสถานะอีกครั้งหรือเปิดเมนูส่งสลิป/สถานะใน LIFF"
      }
    ]);
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!verifyLineSignature(rawBody, request.headers.get("x-line-signature"))) {
    try {
      const testPayload = JSON.parse(rawBody) as { events?: unknown[] };
      if (Array.isArray(testPayload.events) && testPayload.events.length === 0) {
        return NextResponse.json({ ok: true, test: true });
      }
    } catch {
      // Fall through to 401 for malformed or unsigned real webhook calls.
    }

    return NextResponse.json({ error: "Invalid LINE signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as { events: LineEvent[] };
  const supabase = createServiceClient();

  for (const event of payload.events) {
    if (event.type === "follow" && event.replyToken) {
      if (event.source?.userId) {
        await supabase
          .from("line_users")
          .upsert(
            {
              line_user_id: event.source.userId,
              last_seen_at: new Date().toISOString()
            },
            { onConflict: "line_user_id" }
          );
      }

      await replyLine(
        event.replyToken,
        lineMenuMessages("ยินดีต้อนรับค่ะ กดปุ่มด้านล่างเพื่อเลือกงานและรับ QR Code ก่อนโอนเงิน")
      );
      continue;
    }

    if (event.type === "postback" && event.postback?.data === "action=check_status") {
      if (event.replyToken) {
        await replyUserStatus(supabase, event.replyToken, event.source?.userId);
      }
      continue;
    }

    if (event.type !== "message") {
      continue;
    }

    if (event.message?.type === "text") {
      const text = (event.message.text ?? "").trim().toLowerCase();
      const isStatusRequest =
        text.includes("สถานะ") ||
        text === "check status" ||
        text === "status";

      if (!isStatusRequest) {
        if (event.replyToken) {
          await replyLine(
            event.replyToken,
            lineMenuMessages("กรุณากดสร้าง QR ก่อนโอนเงิน หรือกดดูสถานะเพื่อตรวจข้อมูลของฉัน")
          );
        }
        continue;
      }

      if (event.replyToken) {
        await replyUserStatus(supabase, event.replyToken, event.source?.userId);
      }
      continue;
    }

    if (event.message?.type !== "image" || !event.message.id) {
      if (event.replyToken) {
        await replyLine(
          event.replyToken,
          lineMenuMessages("กรุณากดสร้าง QR ก่อนโอนเงิน หรือกดดูสถานะเพื่อตรวจข้อมูลของฉัน")
        );
      }
      continue;
    }

    const lineUserId = event.source?.userId;
    const user = lineUserId
      ? await supabase
          .from("line_users")
          .upsert({ line_user_id: lineUserId, last_seen_at: new Date().toISOString() }, { onConflict: "line_user_id" })
          .select("id")
          .single()
      : null;

    const activeSelection = user?.data
      ? await supabase
          .from("payment_targets")
          .select("id,event_id,display_name,amount_due,status,events(id,slug)")
          .eq("selected_line_user_id", user.data.id)
          .neq("status", "deleted")
          .order("updated_at", { ascending: false })
          .limit(1)
          .single()
      : null;

    if (!activeSelection?.data) {
      if (event.replyToken) {
        await replyLine(
          event.replyToken,
          lineMenuMessages("ยังไม่พบรายชื่อที่เลือกไว้ กรุณากดสร้าง QR และเลือกรายชื่อก่อนส่งสลิป")
        );
      }
      continue;
    }

    if (activeSelection.data.status === "verified") {
      if (event.replyToken) {
        await replyLine(event.replyToken, [
          { type: "text", text: "✅ รายการนี้จ่ายเรียบร้อยแล้ว ไม่ต้องส่งสลิปเพิ่มค่ะ" }
        ]);
      }
      continue;
    }

    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recentCount } = await supabase
        .from("slip_submissions")
        .select("id", { count: "exact", head: true })
        .eq("line_user_id", user?.data?.id ?? "")
        .gte("created_at", oneHourAgo);

      if ((recentCount ?? 0) >= 10) {
        if (event.replyToken) {
          await replyLine(event.replyToken, [
            { type: "text", text: "ส่งสลิปเกินจำนวนที่อนุญาต กรุณารอสักครู่แล้วส่งใหม่ภายหลัง" }
          ]);
        }
        continue;
      }

      const content = await downloadLineContent(event.message.id);
      const eventRow = Array.isArray(activeSelection.data.events)
        ? activeSelection.data.events[0]
        : activeSelection.data.events;
      const slip = await uploadSlipImage({
        eventId: activeSelection.data.event_id,
        eventSlug: eventRow?.slug ?? activeSelection.data.event_id,
        paymentTargetId: activeSelection.data.id,
        personName: activeSelection.data.display_name,
        amountExpected: Number(activeSelection.data.amount_due),
        sourceBuffer: content.buffer,
        mimeType: content.mimeType,
        lineMessageId: event.message.id,
        lineUserDbId: user?.data?.id ?? null,
        deferAutoReview: true
      });

      if (event.replyToken) {
        if (slip.status === "duplicate_blocked") {
          await replyLine(event.replyToken, [
            { type: "text", text: "❌ สลิปนี้เคยส่งแล้ว ระบบไม่บันทึกซ้ำค่ะ" }
          ]);
        } else if (slip.status === "verified") {
          await replyLine(event.replyToken, [
            {
              type: "text",
              text: "✅ ตรวจสลิปผ่านอัตโนมัติจากรูปสลิปแล้วค่ะ หมายเหตุ: เป็นการตรวจจากรูป ไม่ใช่การยืนยันจากธนาคาร"
            }
          ]);
        } else {
          await replyLine(event.replyToken, [
            { type: "text", text: "📋 รับสลิปใหม่แล้วค่ะ ระบบจะใช้ใบล่าสุดให้แอดมินตรวจ" }
          ]);
        }
      }
    } catch {
      if (event.replyToken) {
        await replyLine(event.replyToken, [
          { type: "text", text: "บันทึกสลิปไม่สำเร็จ กรุณาส่งรูปใหม่อีกครั้ง" }
        ]);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
