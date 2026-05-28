import { NextRequest, NextResponse } from "next/server";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

function parseAmount(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  return Number(value.replace(/,/g, "").trim());
}

async function recalculateExpectedTotal(supabase: ReturnType<typeof createServiceClient>, eventId: string) {
  const { data, error } = await supabase
    .from("payment_targets")
    .select("amount_due,status")
    .eq("event_id", eventId)
    .neq("status", "deleted");
  if (error) throw error;

  const expectedTotal = (data ?? []).reduce((sum, target) => sum + Number(target.amount_due ?? 0), 0);
  const { error: updateError } = await supabase
    .from("events")
    .update({ expected_total: expectedTotal })
    .eq("id", eventId);
  if (updateError) throw updateError;
  return expectedTotal;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> }
) {
  try {
    assertAdmin(request);
    const { eventId } = await context.params;
    const supabase = createServiceClient();
    const body = await request.json();

    const displayName = String(body.display_name ?? "").trim();
    const amountDue = parseAmount(body.amount_due);
    const note = body.note ? String(body.note).trim() : null;

    if (!displayName) {
      return NextResponse.json({ error: "กรุณากรอกชื่อ" }, { status: 400 });
    }
    if (!Number.isFinite(amountDue) || amountDue <= 0) {
      return NextResponse.json({ error: "ยอดเงินต้องมากกว่า 0" }, { status: 400 });
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id,name,archived_at")
      .eq("id", eventId)
      .maybeSingle();
    if (eventError) throw eventError;
    if (!event || event.archived_at) {
      return NextResponse.json({ error: "ไม่พบงานนี้ หรืออาจถูกลบ/ปิดไปแล้ว" }, { status: 404 });
    }

    const { data: duplicate, error: duplicateError } = await supabase
      .from("payment_targets")
      .select("id,status")
      .eq("event_id", eventId)
      .eq("display_name", displayName)
      .neq("status", "deleted")
      .maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      return NextResponse.json({ error: "มีรายชื่อนี้ในงานแล้ว" }, { status: 400 });
    }

    const { data: orderRows, error: orderError } = await supabase
      .from("payment_targets")
      .select("sort_order")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: false })
      .limit(1);
    if (orderError) throw orderError;
    const nextSortOrder = Number(orderRows?.[0]?.sort_order ?? 0) + 1;

    const { data: target, error: insertError } = await supabase
      .from("payment_targets")
      .insert({
        event_id: eventId,
        display_name: displayName,
        amount_due: amountDue,
        note,
        status: "unpaid",
        sort_order: nextSortOrder
      })
      .select("*")
      .single();
    if (insertError) throw insertError;

    const expectedTotal = await recalculateExpectedTotal(supabase, eventId);

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "create_payment_target",
      entity_type: "payment_target",
      entity_id: target.id,
      event_id: eventId,
      after_data: { target, expected_total: expectedTotal },
      reason: "เพิ่มรายชื่อในงานเก็บเงิน"
    });

    return NextResponse.json({ target, expected_total: expectedTotal }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
