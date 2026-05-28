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

async function getEditableTarget(
  supabase: ReturnType<typeof createServiceClient>,
  targetId: string
) {
  const { data: target, error } = await supabase
    .from("payment_targets")
    .select("*")
    .eq("id", targetId)
    .maybeSingle();
  if (error) throw error;
  if (!target) {
    return { target: null, response: NextResponse.json({ error: "ไม่พบรายชื่อนี้" }, { status: 404 }) };
  }
  if (target.status === "verified") {
    return {
      target,
      response: NextResponse.json({ error: "รายชื่อนี้จ่ายแล้ว จึงแก้ไขหรือลบไม่ได้" }, { status: 400 })
    };
  }
  return { target, response: null };
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ targetId: string }> }
) {
  try {
    assertAdmin(request);
    const { targetId } = await context.params;
    const supabase = createServiceClient();
    const { target, response } = await getEditableTarget(supabase, targetId);
    if (response) return response;
    if (!target) {
      return NextResponse.json({ error: "ไม่พบรายชื่อนี้" }, { status: 404 });
    }

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

    const { data: duplicate, error: duplicateError } = await supabase
      .from("payment_targets")
      .select("id")
      .eq("event_id", target.event_id)
      .eq("display_name", displayName)
      .neq("id", target.id)
      .neq("status", "deleted")
      .maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) {
      return NextResponse.json({ error: "มีรายชื่อนี้ในงานแล้ว" }, { status: 400 });
    }

    const { data: updatedTarget, error: updateError } = await supabase
      .from("payment_targets")
      .update({
        display_name: displayName,
        amount_due: amountDue,
        note
      })
      .eq("id", target.id)
      .select("*")
      .single();
    if (updateError) throw updateError;

    const expectedTotal = await recalculateExpectedTotal(supabase, target.event_id);

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "update_payment_target",
      entity_type: "payment_target",
      entity_id: target.id,
      event_id: target.event_id,
      before_data: target,
      after_data: { target: updatedTarget, expected_total: expectedTotal },
      reason: "แก้ไขรายชื่อ/ยอดเงินในงานเก็บเงิน"
    });

    return NextResponse.json({ target: updatedTarget, expected_total: expectedTotal });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ targetId: string }> }
) {
  try {
    assertAdmin(request);
    const { targetId } = await context.params;
    const supabase = createServiceClient();
    const { target, response } = await getEditableTarget(supabase, targetId);
    if (response) return response;
    if (!target) {
      return NextResponse.json({ error: "ไม่พบรายชื่อนี้" }, { status: 404 });
    }

    const { data: deletedTarget, error: deleteError } = await supabase
      .from("payment_targets")
      .update({ status: "deleted" })
      .eq("id", target.id)
      .select("*")
      .single();
    if (deleteError) throw deleteError;

    const expectedTotal = await recalculateExpectedTotal(supabase, target.event_id);

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "delete_payment_target",
      entity_type: "payment_target",
      entity_id: target.id,
      event_id: target.event_id,
      before_data: target,
      after_data: { target: deletedTarget, expected_total: expectedTotal },
      reason: "ลบรายชื่อออกจากงานเก็บเงิน"
    });

    return NextResponse.json({ ok: true, expected_total: expectedTotal });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
