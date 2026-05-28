import QRCode from "qrcode";
import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { getBearerToken, verifyAndGetProfile } from "@/lib/liff";
import { buildPromptPayPayload } from "@/lib/promptpay";
import { getSettings } from "@/lib/settings";
import { createServiceClient } from "@/lib/supabase/server";

type LiffMode = "pay" | "slip" | "me";

function normalizePage(value: string | null | undefined): LiffMode {
  return value === "slip" || value === "me" ? value : "pay";
}

function eventFromRelation<T>(relation: T | T[] | null | undefined): T | null {
  if (Array.isArray(relation)) return relation[0] ?? null;
  return relation ?? null;
}

function mapTarget(target: {
  id: string;
  display_name: string;
  amount_due: number | string;
  status: string;
  selected_line_user_id?: string | null;
  sort_order?: number | null;
}, order: number) {
  return {
    id: target.id,
    order: target.sort_order ?? order,
    display_name: target.display_name,
    amount_due: Number(target.amount_due),
    status: target.status,
    is_selected: Boolean(target.selected_line_user_id)
  };
}

async function getActiveSelection(
  supabase: ReturnType<typeof createServiceClient>,
  lineUserId: string
) {
  const { data: target, error } = await supabase
    .from("payment_targets")
    .select("id,event_id,display_name,amount_due,status,events(id,name,slug,promptpay_id,promptpay_type,is_open,archived_at)")
    .eq("selected_line_user_id", lineUserId)
    .neq("status", "deleted")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!target) return null;

  const event = eventFromRelation(target.events);
  if (!event?.promptpay_id || !event.is_open || event.archived_at) return null;

  const amount = Number(target.amount_due);
  const payload = buildPromptPayPayload(event.promptpay_id, amount, event.promptpay_type);
  const qrDataUrl = await QRCode.toDataURL(payload, {
    margin: 1,
    width: 720,
    color: { dark: "#202840", light: "#ffffff" }
  });

  return {
    event: { id: event.id, name: event.name },
    target: {
      id: target.id,
      display_name: target.display_name,
      amount_due: amount,
      status: target.status
    },
    qr: { data_url: qrDataUrl, payload }
  };
}

async function getOpenEventsWithFirstTargets(supabase: ReturnType<typeof createServiceClient>) {
  const { data: events, error } = await supabase
    .from("events")
    .select("id,name,slug,promptpay_id,promptpay_type,is_open,archived_at")
    .eq("is_open", true)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const firstEventId = events?.[0]?.id;
  const { data: targets, error: targetsError } = firstEventId
    ? await supabase
        .from("payment_targets")
        .select("id,display_name,amount_due,status,selected_line_user_id,sort_order,created_at")
        .eq("event_id", firstEventId)
        .neq("status", "deleted")
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(500)
    : { data: [], error: null };

  if (targetsError) throw targetsError;

  return (events ?? []).map((event) => ({
    id: event.id,
    name: event.name,
    slug: event.slug,
    has_promptpay: Boolean(event.promptpay_id),
    targets:
      event.id === firstEventId
        ? (targets ?? []).map((target, index) => mapTarget(target, index + 1))
        : []
  }));
}

async function getPayments(
  supabase: ReturnType<typeof createServiceClient>,
  lineUserId: string
) {
  const { data: targets, error: targetsError } = await supabase
    .from("payment_targets")
    .select("id,display_name,amount_due,status,paid_at,events(id,name,slug,is_open,archived_at)")
    .eq("selected_line_user_id", lineUserId)
    .neq("status", "deleted")
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

  return (targets ?? []).flatMap((target) => {
    const event = eventFromRelation(target.events);
    if (!event || event.archived_at || !event.is_open) return [];
    return {
      id: target.id,
      display_name: target.display_name,
      amount_due: Number(target.amount_due),
      status: target.status,
      paid_at: target.paid_at,
      event: {
        id: event.id,
        name: event.name,
        slug: event.slug,
        is_open: event.is_open
      },
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
  });
}

async function handleBootstrap(request: NextRequest, input: { accessToken?: string; page?: string }) {
  const accessToken = input.accessToken || getBearerToken(request);
  if (!accessToken) {
    return NextResponse.json({ error: "กรุณาเปิดผ่าน LINE LIFF" }, { status: 401 });
  }

  const page = normalizePage(input.page);
  const profile = await verifyAndGetProfile(accessToken);
  const supabase = createServiceClient();

  const [{ data: lineUser, error: lineUserError }, settings] = await Promise.all([
    supabase
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
      .single(),
    getSettings(["contact_url"])
  ]);

  if (lineUserError) throw lineUserError;

  const [selection, pageData] = await Promise.all([
    page === "slip" ? getActiveSelection(supabase, lineUser.id) : Promise.resolve(null),
    page === "me" ? getPayments(supabase, lineUser.id) : getOpenEventsWithFirstTargets(supabase)
  ]);

  const fallbackToPay = page === "slip" && !selection;

  return NextResponse.json({
    page: fallbackToPay ? "pay" : page,
    profile,
    contactUrl: settings.contact_url ?? "",
    selection,
    events: page === "me" ? [] : pageData,
    payments: page === "me" ? pageData : [],
    notice: fallbackToPay
      ? "ยังไม่พบ QR ที่สร้างไว้ กรุณาเลือกงานและรายชื่อก่อนส่งสลิป"
      : null
  });
}

export async function GET(request: NextRequest) {
  try {
    return await handleBootstrap(request, {
      page: request.nextUrl.searchParams.get("page") ?? undefined
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { accessToken?: string; page?: string };
    return await handleBootstrap(request, body);
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
