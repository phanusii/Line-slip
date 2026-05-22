import QRCode from "qrcode";
import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { getLineProfile, verifyLineAccessToken } from "@/lib/liff";
import { buildPromptPayPayload } from "@/lib/promptpay";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { accessToken?: string };
    if (!body.accessToken) {
      return NextResponse.json({ error: "กรุณาเปิดผ่าน LINE LIFF" }, { status: 400 });
    }

    await verifyLineAccessToken(body.accessToken);
    const profile = await getLineProfile(body.accessToken);
    const supabase = createServiceClient();

    const { data: lineUser, error: lineUserError } = await supabase
      .from("line_users")
      .select("id")
      .eq("line_user_id", profile.userId)
      .maybeSingle();

    if (lineUserError) throw lineUserError;
    if (!lineUser) return NextResponse.json({ selection: null });

    const { data: target, error: targetError } = await supabase
      .from("payment_targets")
      .select("id,event_id,display_name,amount_due,status,events(id,name,slug,promptpay_id,is_open,archived_at)")
      .eq("selected_line_user_id", lineUser.id)
      .neq("status", "verified")
      .neq("status", "deleted")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (targetError) throw targetError;
    if (!target) return NextResponse.json({ selection: null });

    const event = Array.isArray(target.events) ? target.events[0] : target.events;
    if (!event?.promptpay_id || !event.is_open || event.archived_at) {
      return NextResponse.json({ selection: null });
    }

    const amount = Number(target.amount_due);
    const payload = buildPromptPayPayload(event.promptpay_id, amount);
    const qrDataUrl = await QRCode.toDataURL(payload, {
      margin: 1,
      width: 720,
      color: { dark: "#202840", light: "#ffffff" }
    });

    return NextResponse.json({
      selection: {
        event: { id: event.id, name: event.name },
        target: {
          id: target.id,
          display_name: target.display_name,
          amount_due: amount,
          status: target.status
        },
        qr: { data_url: qrDataUrl, payload }
      }
    });
  } catch (error) {
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
