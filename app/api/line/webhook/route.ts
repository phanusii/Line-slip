import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { downloadLineContent, uploadSlipImage } from "@/lib/slips";
import { replyLine, verifyLineSignature } from "@/lib/line";

type LineEvent = {
  type: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { id: string; type: string };
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
      await replyLine(event.replyToken, [
        { type: "text", text: "ส่งสลิปเข้ามาได้เลย หรือเลือกงานและรายชื่อเพื่อรับ QR Code ก่อนโอน" }
      ]);
      continue;
    }

    if (event.type !== "message" || event.message?.type !== "image" || !event.message.id) {
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
        await replyLine(event.replyToken, [
          { type: "text", text: "ยังไม่พบรายชื่อที่เลือกไว้ กรุณาเลือกงานและรายชื่อก่อนส่งสลิป" }
        ]);
      }
      continue;
    }

    try {
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
