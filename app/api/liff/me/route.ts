import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { getLineProfile, verifyLineAccessToken } from "@/lib/liff";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { accessToken?: string };
    if (!body.accessToken) {
      return NextResponse.json(
        { error: "กรุณาเปิดผ่าน LINE LIFF เพื่อดูข้อมูลของฉัน" },
        { status: 400 }
      );
    }

    await verifyLineAccessToken(body.accessToken);
    const profile = await getLineProfile(body.accessToken);
    const supabase = createServiceClient();

    const { data: lineUser, error: userError } = await supabase
      .from("line_users")
      .select("id,line_user_id,display_name,picture_url")
      .eq("line_user_id", profile.userId)
      .maybeSingle();

    if (userError) throw userError;

    if (!lineUser) {
      return NextResponse.json({
        profile,
        payments: []
      });
    }

    const { data: targets, error: targetsError } = await supabase
      .from("payment_targets")
      .select("id,display_name,amount_due,status,paid_at,events(id,name,slug,is_open)")
      .eq("selected_line_user_id", lineUser.id)
      .order("updated_at", { ascending: false });

    if (targetsError) throw targetsError;

    const targetIds = (targets ?? []).map((target) => target.id);
    const slips = targetIds.length
      ? await supabase
          .from("slip_submissions")
          .select("id,payment_target_id,status,amount_detected,amount_expected,created_at,file_deleted_at,metadata_deleted_at")
          .in("payment_target_id", targetIds)
          .is("metadata_deleted_at", null)
          .order("created_at", { ascending: false })
      : { data: [], error: null };

    if (slips.error) throw slips.error;

    return NextResponse.json({
      profile,
      payments: (targets ?? []).map((target) => {
        const event = Array.isArray(target.events) ? target.events[0] : target.events;
        return {
          id: target.id,
          display_name: target.display_name,
          amount_due: Number(target.amount_due),
          status: target.status,
          paid_at: target.paid_at,
          event: event
            ? {
                id: event.id,
                name: event.name,
                slug: event.slug,
                is_open: event.is_open
              }
            : null,
          slips: (slips.data ?? [])
            .filter((slip) => slip.payment_target_id === target.id)
            .map((slip) => ({
              id: slip.id,
              status: slip.status,
              amount_detected: slip.amount_detected,
              amount_expected: slip.amount_expected,
              created_at: slip.created_at,
              file_deleted_at: slip.file_deleted_at
            }))
        };
      })
    });
  } catch (error) {
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
