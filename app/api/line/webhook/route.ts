import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { downloadLineContent, uploadSlipImage } from "@/lib/slips";
import {
  buildCheckStatusFlex,
  buildSlipStatusFlex,
  lineMenuMessages,
  liffUri,
  replyLine,
  verifyLineSignature
} from "@/lib/line";

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { id: string; type: string; text?: string };
  postback?: { data: string; displayText?: string };
};

/** ดึงสถานะสลิปล่าสุดของผู้ใช้ แล้วสร้าง reply message (ฟรี — ไม่ใช้ push) */
async function buildStatusReply(
  lineUserId: string
): Promise<unknown[]> {
  const supabase = createServiceClient();

  const { data: lineUser } = await supabase
    .from("line_users")
    .select("id")
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (!lineUser) return [buildCheckStatusFlex(liffUri("me"))];

  // รายชื่อที่เลือกล่าสุด (ทุกสถานะยกเว้น deleted)
  const { data: target } = await supabase
    .from("payment_targets")
    .select("id,display_name,amount_due,status,paid_at,events(name)")
    .eq("selected_line_user_id", lineUser.id)
    .neq("status", "deleted")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!target) return [buildCheckStatusFlex(liffUri("me"))];

  const eventRow = Array.isArray(target.events) ? target.events[0] : target.events;
  const eventName = eventRow?.name ?? "";

  // ถ้า verified ใช้ข้อมูล target โดยตรง
  if (target.status === "verified") {
    return [
      buildSlipStatusFlex({
        displayName: target.display_name,
        eventName,
        amountDue: Number(target.amount_due),
        status: "verified",
        submittedAt: null,
        paidAt: target.paid_at ?? null
      })
    ];
  }

  // ดึงสลิปล่าสุดที่ยังไม่ถูกแทนที่ เพื่อหาวันที่ส่งและสถานะล่าสุด
  const { data: latestSlip } = await supabase
    .from("slip_submissions")
    .select("status,created_at")
    .eq("payment_target_id", target.id)
    .is("metadata_deleted_at", null)
    .is("replaced_by_slip_id", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // กำหนดสถานะที่จะแสดงบนการ์ด
  const displayStatus =
    latestSlip?.status === "rejected" ? "rejected"
    : latestSlip ? "manual_review"
    : target.status; // pending_slip / unpaid

  return [
    buildSlipStatusFlex({
      displayName: target.display_name,
      eventName,
      amountDue: Number(target.amount_due),
      status: displayStatus,
      submittedAt: latestSlip?.created_at ?? null,
      paidAt: null
    })
  ];
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!verifyLineSignature(rawBody, request.headers.get("x-line-signature"))) {
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
      const lineUserId = event.source?.userId;
      if (lineUserId && event.replyToken) {
        const messages = await buildStatusReply(lineUserId);
        await replyLine(event.replyToken, messages);
      }
      continue;
    }

    if (event.type !== "message") {
      continue;
    }

    // Text trigger จาก liff.sendMessages() หลังส่งสลิป — reply ด้วยการ์ดสถานะ (ฟรี)
    if (
      event.message?.type === "text" &&
      event.message.text === "ดูสถานะสลิปล่าสุด" &&
      event.source?.userId &&
      event.replyToken
    ) {
      const messages = await buildStatusReply(event.source.userId);
      await replyLine(event.replyToken, messages);
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
      // Rate limit: max 10 slip submissions per LINE user per hour
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
