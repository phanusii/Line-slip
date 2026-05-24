import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { getLineProfile, verifyLineAccessToken } from "@/lib/liff";
import { runSlipAutoReviewById } from "@/lib/slips";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { accessToken?: string; slipId?: string };
    const accessToken = String(body.accessToken ?? "");
    const slipId = String(body.slipId ?? "");

    if (!accessToken || !slipId) {
      return NextResponse.json({ error: "ข้อมูลตรวจสลิปไม่ครบ" }, { status: 400 });
    }

    await verifyLineAccessToken(accessToken);
    const profile = await getLineProfile(accessToken);
    const supabase = createServiceClient();

    const { data: lineUser, error: lineUserError } = await supabase
      .from("line_users")
      .select("id")
      .eq("line_user_id", profile.userId)
      .maybeSingle();

    if (lineUserError) throw lineUserError;
    if (!lineUser) {
      return NextResponse.json({ error: "ไม่พบผู้ใช้ LINE สำหรับตรวจสลิป" }, { status: 404 });
    }

    const { data: slip, error: slipError } = await supabase
      .from("slip_submissions")
      .select("id,line_user_id")
      .eq("id", slipId)
      .maybeSingle();

    if (slipError) throw slipError;
    if (!slip) {
      return NextResponse.json({ error: "ไม่พบสลิปที่ต้องการตรวจ" }, { status: 404 });
    }
    if (slip.line_user_id !== lineUser.id) {
      return NextResponse.json({ error: "ไม่มีสิทธิ์ตรวจสลิปนี้" }, { status: 403 });
    }

    const review = await runSlipAutoReviewById(slipId);
    return NextResponse.json({ ok: true, review });
  } catch (error) {
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
