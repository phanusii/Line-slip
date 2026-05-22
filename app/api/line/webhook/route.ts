import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { downloadLineContent, uploadSlipImage } from "@/lib/slips";
import {
  buildCheckStatusFlex,
  buildVerifiedStatusFlex,
  lineMenuMessages,
  liffUri,
  replyLine,
  verifyLineSignature
} from "@/lib/line";

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { id: string; type: string };
  postback?: { data: string; displayText?: string };
};

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
        const { data: lineUser } = await supabase
          .from("line_users")
          .select("id")
          .eq("line_user_id", lineUserId)
          .single();

        const verifiedTarget = lineUser
          ? await supabase
              .from("payment_targets")
              .select("display_name,amount_due,paid_at,events(name)")
              .eq("selected_line_user_id", lineUser.id)
              .eq("status", "verified")
              .order("paid_at", { ascending: false })
              .limit(1)
              .single()
          : null;

        if (verifiedTarget?.data) {
          const t = verifiedTarget.data;
          const ev = t.events as { name?: string } | Array<{ name?: string }> | null;
          const eventName = Array.isArray(ev) ? ev[0]?.name : ev?.name;
          await replyLine(event.replyToken, [
            buildVerifiedStatusFlex({
              displayName: t.display_name,
              eventName: eventName ?? "",
              amountDue: Number(t.amount_due),
              paidAt: t.paid_at ?? null
            })
          ]);
        } else {
          await replyLine(event.replyToken, [buildCheckStatusFlex(liffUri("me"))]);
        }
      }
      continue;
    }

    if (event.type !== "message") {
      continue;
    }

    if (event.message?.type !== "image" || !event.message.id) {
      if (event.replyToken) {
        await replyLine(
          event.replyToken,
          lineMenuMessages("กรุณากดเลือกงานก่อนโอนเงิน หรือกดดูข้อมูลของฉันเพื่อตรวจสถานะ")
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
          .select("id,event_id,display_name,amount_due,events(id,slug)")
          .eq("selected_line_user_id", user.data.id)
          .neq("status", "verified")
          .order("updated_at", { ascending: false })
          .limit(1)
          .single()
      : null;

    if (!activeSelection?.data) {
      if (event.replyToken) {
        await replyLine(
          event.replyToken,
          lineMenuMessages("ยังไม่พบรายชื่อที่เลือกไว้ กรุณากดเลือกงานและรายชื่อก่อนส่งสลิป")
        );
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
        lineMessageId: event.message.id
      });

      if (user?.data) {
        await supabase
          .from("slip_submissions")
          .update({ line_user_id: user.data.id })
          .eq("id", slip.id);
      }

      if (event.replyToken) {
        await replyLine(event.replyToken, [
          { type: "text", text: "รับสลิปแล้ว ระบบบันทึกไฟล์ไว้เรียบร้อยและส่งให้แอดมินตรวจสอบ" }
        ]);
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
